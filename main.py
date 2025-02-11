import logging
from fastapi import FastAPI, HTTPException, Depends, Header, UploadFile, File, Form, BackgroundTasks
from fastapi.security import HTTPBasic, HTTPBasicCredentials
from fastapi.responses import HTMLResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from datetime import datetime, timedelta
from pydantic import BaseModel, Field
from dotenv import load_dotenv
from typing import Optional, Literal
import os
import re
import json
import uuid
import requests
import secrets
import threading
import subprocess
import time
import random
import boto3
from urllib.parse import urlparse

# Load configuration from environment variables
origins = json.loads(os.getenv("ALLOWED_ORIGINS", '["http://localhost:8000", "https://telestreamcloud.net"]'))
MAX_STREAMS = int(os.getenv("MAX_STREAMS", "10"))
users = json.loads(os.getenv("USERS", '{"Admin": "1234"}'))
# Load S3 Bucket Details from environment variables
AWS_S3_BUCKET = os.getenv("AWS_S3_BUCKET")
AWS_REGION = os.getenv("AWS_REGION")
AWS_ACCESS_KEY = os.getenv("AWS_ACCESS_KEY")
AWS_SECRET_KEY = os.getenv("AWS_SECRET_KEY")

app = FastAPI()
security = HTTPBasic()
load_dotenv()

# CORS middleware configuration
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
#init S3 Client
s3_client = boto3.client(
    's3',
    aws_access_key_id=AWS_ACCESS_KEY,
    aws_secret_access_key=AWS_SECRET_KEY,
    region_name=AWS_REGION
)

# Initialize API keys and other dictionaries
api_keys = {}
active_streams = {}
stream_status = {}
stream_start_time = {}
playlists = {}  # Store playlists in memory
# Store bandwidth data for each stream
stream_bandwidth = {}  
# Store file expiry timestamps
file_expiry_map = {}

# Media files directory for local files
TEMP_DIR = os.getenv("TEMP_DIR", "/app/temp")

# Ensure the directories exist
os.makedirs(TEMP_DIR, exist_ok=True)
# Set up logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

class StreamRequest(BaseModel):
    input_type: Literal['file', 'url']
    file: Optional[str] = None
    duration: int
    destination: list[str]  # Can be single or a comma-separated list for redundancy
    start_offset: int = 0
    redundant: bool = False  # New flag to indicate redundancy

class Playlist(BaseModel):
    playlist_id: str
    name: str
    files: list[str]    

# Ensure TEMP_DIR exists
os.makedirs(TEMP_DIR, exist_ok=True)

def generate_api_key():
    return secrets.token_urlsafe(32)

def verify_api_key(x_api_key: str = Header(...)):
    expiration_time = api_keys.get(x_api_key)
    if not expiration_time or datetime.utcnow() > expiration_time:
        raise HTTPException(status_code=403, detail="Invalid or expired API Key")
    
def list_s3_files():
    """List all media files from the S3 bucket."""
    logger.info("Connecting to S3 to list files...")
    try:
        response = s3_client.list_objects_v2(Bucket=AWS_S3_BUCKET)
        if "Contents" in response:
            file_list = [obj["Key"] for obj in response["Contents"]]
            logger.info(f"Found {len(file_list)} files in S3.")
            return file_list
        else:
            logger.warning("No files found in S3 bucket.")
            return []
    except Exception as e:
        logger.error(f"Failed to list media files from S3: {e}")
        return []
    

def download_file_in_background(url, stream_id, destination, duration):
    filename = os.path.join(TEMP_DIR, str(uuid.uuid4()) + os.path.basename(urlparse(url).path))
    stream_status[stream_id] = {"status": "Downloading", "file": filename, "destination": destination}

    try:
        response = requests.get(url, stream=True)
        if response.status_code == 200:
            with open(filename, 'wb') as f:
                for chunk in response.iter_content(chunk_size=8192):
                    f.write(chunk)
            stream_status[stream_id]["status"] = "Downloaded"
            start_ffmpeg_stream(filename, destination, duration, stream_id)
        else:
            raise Exception(f"Failed to download file. HTTP status code: {response.status_code}")
    except Exception as e:
        logger.error(f"Error downloading file for stream {stream_id}: {e}")
        stream_status[stream_id] = {"status": "Error", "message": str(e)}

def start_ffmpeg_stream(input_source, destinations, duration, stream_id, redundant=False):
    if isinstance(destinations, str):
        destinations = [destinations]

    # Ensure file name is stored correctly
    if stream_id in stream_status:
        stream_status[stream_id]["file"] = os.path.basename(input_source)  # Store correct filename

    processes = []
    for dest in destinations:
        ffmpeg_cmd = [
            "ffmpeg", "-re", "-stream_loop", "-1", "-i", input_source,
            "-aspect", "16:9", "-ar", "48000", "-f", "mpegts", dest.strip(),
            "-progress", "pipe:2", "-loglevel", "info"
        ]

        process = subprocess.Popen(ffmpeg_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        processes.append(process)

        logger.info(f"Started {'redundant' if redundant else 'single'} stream {stream_id} to {dest.strip()}")

        # Update stream status to "Streaming"
        stream_status[stream_id]["status"] = "Streaming"

        # Start monitoring FFmpeg
        threading.Thread(target=monitor_ffmpeg_bandwidth, args=(process, stream_id, destinations), daemon=True).start()
        threading.Thread(target=monitor_ffmpeg_errors, args=(process, stream_id), daemon=True).start()

    active_streams[stream_id] = processes
    stream_start_time[stream_id] = time.time()

    # Schedule stream stopping after duration
    threading.Timer(duration, stop_ffmpeg_stream, args=[stream_id]).start()


def monitor_ffmpeg_errors(process, stream_id, duration, input_source):
    """
    Reads FFmpeg stderr output in real-time and captures only the last 5 lines
    that contain actual error messages, avoiding unnecessary long logs.
    """
    error_keywords = ["Error", "failed", "cannot", "Invalid", "unable", "not found"]
    ignore_keywords = [
        "ffmpeg version", "built with", "configuration:", "libav", "Input #0,", "Metadata:",
        "Duration:", "Stream #", "handler_name", "vendor_id", "creation_time", "bitrate=", "frame="
    ]

    relevant_errors = []
    max_lines_to_check = 5  # Limit error analysis to last 5 lines

    def read_stderr():
        """ Continuously reads stderr and filters for real error messages """
        buffer = []  # Buffer to store last 5 lines

        for line in iter(process.stderr.readline, b""):
            decoded_line = line.decode("utf-8", errors="ignore").strip()

            # Keep a rolling buffer of the last `max_lines_to_check` lines
            buffer.append(decoded_line)
            if len(buffer) > max_lines_to_check:
                buffer.pop(0)  # Remove the oldest line

        # Once FFmpeg stops, check only the last few lines
        for line in buffer:
            if any(keyword in line for keyword in error_keywords):
                relevant_errors.append(line)

        if relevant_errors:
            filtered_errors = "\n".join(relevant_errors)  # Only real error messages
            logger.error(f"FFmpeg error for stream {stream_id}: {filtered_errors}")
            stream_status[stream_id] = {"status": "Error", "message": filtered_errors}
            stop_ffmpeg_stream(stream_id)

    # Start stderr monitoring in a separate thread
    threading.Thread(target=read_stderr, daemon=True).start()
     # Schedule stream stopping after the duration
    threading.Timer(duration, stop_ffmpeg_stream, args=[stream_id, input_source]).start()


def stop_ffmpeg_stream(stream_id, file_path=None):
    # Get the processes associated with this stream ID
    processes = active_streams.pop(stream_id, None)

    if processes:
        for process in processes:
            try:
                process.terminate()
                process.wait(timeout=5)
                logger.info(f"FFmpeg process terminated for stream_id: {stream_id}")
            except subprocess.TimeoutExpired:
                process.kill()
                logger.error(f"FFmpeg process for stream_id {stream_id} did not terminate in time, forced termination.")

    # Update stream status
    if stream_id in stream_status:
        if stream_status[stream_id]["status"] != "Error":
            stream_status[stream_id] = {"status": "Stream stopped", "remaining_duration": 0}
            logger.info(f"Stream {stream_id} status updated to 'Stream stopped'.")
        else:
            logger.info(f"Stream {stream_id} was in error state. Keeping it in 'Error' state.")

    # Clean up temp files
    if file_path and file_path.startswith(TEMP_DIR) and os.path.exists(file_path):
        try:
            os.remove(file_path)
            logger.info(f"Removed temporary file for stream_id: {stream_id}")
        except Exception as e:
            logger.error(f"Error removing temp file for stream_id {stream_id}: {e}")


def monitor_ffmpeg_bandwidth(process, stream_id, destinations):
    """
    Reads FFmpeg logs and extracts bandwidth per stream and destination.
    """
    bitrate_pattern = re.compile(r"bitrate=\s*(\d+\.?\d*)")  #Improved regex

    if stream_id not in stream_bandwidth:
        stream_bandwidth[stream_id] = {}

    while True:
        line = process.stderr.readline()
        if not line:
            break  # Stop if FFmpeg process exits

        decoded_line = line.decode("utf-8", errors="ignore").strip()

        # Debugging: Print all FFmpeg logs
        logger.info(f"FFmpeg Log [{stream_id}]: {decoded_line}")

        match = bitrate_pattern.search(decoded_line)
        if match:
            bitrate_kbps = float(match.group(1))  # Convert to float
            bandwidth_mbps = round(bitrate_kbps / 1000, 2)  # Convert kbps → Mbps

            for destination in destinations:
                stream_bandwidth[stream_id][destination] = bandwidth_mbps  # Store per destination

            # Debugging: Log bandwidth updates
            logger.info(f"Updated bandwidth: Stream {stream_id} -> {destinations} = {bandwidth_mbps} Mbps")

def download_file_from_s3(s3_key):
    """Download a file from S3 to a temporary directory."""
    local_path = os.path.join(TEMP_DIR, os.path.basename(s3_key))
    logger.info(f"Attempting to download file '{s3_key}' from S3 to '{local_path}'...")

    try:
        s3_client.download_file(AWS_S3_BUCKET, s3_key, local_path)
        logger.info(f"Successfully downloaded {s3_key} to {local_path}.")
        return local_path
    except Exception as e:
        logger.error(f"Error downloading {s3_key} from S3: {e}")
        return None
    


@app.post("/start-stream")
async def start_stream(request: StreamRequest, api_key: str = Depends(verify_api_key)):
    logger.info(f"Received request to start stream: {request}")

    if len(active_streams) >= MAX_STREAMS:
        logger.warning("Maximum number of active streams reached.")
        raise HTTPException(status_code=429, detail="Max streams reached")

    stream_id = str(uuid.uuid4())
    logger.info(f"Generated new stream ID: {stream_id}")

    # Determine file to use
    if request.file:
        file_to_use = request.file
    else:
        files = list_s3_files()
        if not files:
            logger.error("No media files available in S3!")
            raise HTTPException(status_code=400, detail="No media files available.")
        file_to_use = random.choice(files)

    # Immediately update UI with "Downloading" state
    stream_status[stream_id] = {
        "status": "Downloading",
        "remaining_duration": request.duration,
        "destination": request.destination,
        "scheduled_start_time": None,
        "redundant": request.redundant,
        "file": file_to_use  # Show filename in UI
    }

    def delayed_stream_start():
        logger.info(f"Starting stream {stream_id} after {request.start_offset} sec delay")

        file_path = download_file_from_s3(file_to_use)
        if not file_path:
            logger.error(f"Failed to download {file_to_use} from S3. Cannot start stream.")
            stream_status[stream_id]["status"] = "Error: Failed to download from S3"
            return

        stream_status[stream_id]["status"] = "Downloaded"
        stream_status[stream_id]["file"] = os.path.basename(file_path)

        logger.info(f"File {stream_status[stream_id]['file']} downloaded successfully, starting stream {stream_id}.")
        threading.Thread(target=start_ffmpeg_stream, args=(file_path, request.destination, request.duration, stream_id, request.redundant)).start()

    if request.start_offset > 0:
        logger.info(f"Scheduling stream {stream_id} to start in {request.start_offset} seconds.")
        stream_status[stream_id]["status"] = "Scheduled"
        stream_status[stream_id]["scheduled_start_time"] = datetime.utcnow().isoformat()
        threading.Timer(request.start_offset, delayed_stream_start).start()
    else:
        threading.Thread(target=delayed_stream_start).start()

    return {
        "status": "success",
        "stream_id": stream_id,
        "destination": request.destination,
        "redundant": request.redundant,
        "file": stream_status[stream_id]["file"],  # Return the filename
        "scheduled_start_time": stream_status[stream_id].get("scheduled_start_time"),
        "message": "Stream is downloading and will start shortly."
    }



@app.get("/bandwidth/{stream_id}")
async def get_bandwidth(stream_id: str, api_key: str = Depends(verify_api_key)):
    if stream_id not in stream_bandwidth:
        logger.warning(f"Bandwidth request for unknown stream {stream_id}")
        raise HTTPException(status_code=404, detail="Stream ID not found")

    return {"stream_id": stream_id, "bandwidth": stream_bandwidth[stream_id]}


@app.get("/list-media")
async def list_media_files(api_key: str = Depends(verify_api_key)):
    logger.info("Fetching media files from S3...")
    files = list_s3_files()
    if not files:
        logger.warning("No media files found in S3!")
    else:
        logger.info(f"Retrieved {len(files)} media files from S3: {files}")
    return {"files": files}


@app.post("/stop-stream/{stream_id}")
async def stop_stream(stream_id: str, api_key: str = Depends(verify_api_key)):
    """Stops a stream and cleans up resources."""
    if stream_id not in stream_status:
        logger.warning(f"Attempted to stop non-existing stream {stream_id}")
        raise HTTPException(status_code=404, detail="Stream not found")

    stop_ffmpeg_stream(stream_id)

    return {"status": "stopped", "stream_id": stream_id}

@app.get("/files")
async def list_s3_files_endpoint(api_key: str = Depends(verify_api_key)):
    """List all available media files in the S3 bucket."""
    logger.info("Fetching media files from S3...")
    files = list_s3_files()
    
    if not files:
        logger.warning("No media files found in S3!")
        return {"files": []}

    logger.info(f"Retrieved {len(files)} media files from S3: {files}")
    return {"files": files}

ALLOWED_EXTENSIONS = {".mp4", ".mkv", ".mxf", ".mov", ".avi"}

@app.post("/upload")
async def upload_file(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    expire_time: Optional[int] = None,  # Remove `Form(...)` to test
    api_key: str = Header(...)
):
    print(f"DEBUG: Received upload request")
    print(f"DEBUG: File name: {file.filename}")
    print(f"DEBUG: Expire time: {expire_time}")
    print(f"DEBUG: API Key: {api_key}")

    # Verify API Key
    if not api_key:
        raise HTTPException(status_code=403, detail="Invalid API key")

    try:
        # Upload file to S3
        s3_client.upload_fileobj(file.file, AWS_S3_BUCKET, file.filename)

        expiry_time = None
        if expire_time:
            expiry_time = datetime.utcnow() + timedelta(minutes=expire_time)
            file_expiry_map[file.filename] = expiry_time
            background_tasks.add_task(schedule_file_deletion, file.filename, expiry_time)

        return {"status": "success", "filename": file.filename, "expires_at": expiry_time.isoformat() if expiry_time else None}
    
    except Exception as e:
        print(f"Upload error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


def schedule_file_deletion(filename: str, expiry_time: datetime):
    """Waits until expiry time and then deletes the file from S3."""
    now = datetime.utcnow()
    delay_seconds = (expiry_time - now).total_seconds()

    if delay_seconds > 0:
        time.sleep(delay_seconds)

    try:
        s3_client.delete_object(Bucket=AWS_S3_BUCKET, Key=filename)
        print(f"File {filename} expired and was deleted from S3.")
        file_expiry_map.pop(filename, None)  # Remove from expiry tracking
    except Exception as e:
        print(f"Error deleting expired file {filename}: {e}")

@app.post("/stop-random-source/{stream_id}")
async def stop_random_source(stream_id: str, api_key: str = Depends(verify_api_key)):
    """
    Stops one random source if the stream is redundant. 
    If the stream is not redundant, it stops the only source.
    """
    if stream_id not in stream_status:
        raise HTTPException(status_code=404, detail="Stream not found")

    stream_info = stream_status[stream_id]

    if not stream_info.get("destination"):
        raise HTTPException(status_code=400, detail="Stream does not have a valid destination")

    destinations = stream_info["destination"]
    is_redundant = stream_info.get("redundant", False)

    # If it's redundant, choose one randomly to stop
    if is_redundant and len(destinations) > 1:
        stop_target = random.choice(destinations)
        destinations.remove(stop_target)  # Remove from list but keep others running
        logger.info(f"Stopping one redundant source: {stop_target}")

        # Stop only the selected FFmpeg process
        processes = active_streams.get(stream_id, [])
        for process in processes:
            if process.poll() is None:  # Ensure process is still running
                process.terminate()
                process.wait(timeout=5)
                break  # Stop only one process

        stream_status[stream_id]["destination"] = destinations  # Update active destinations
        return {"status": "one source stopped", "stream_id": stream_id, "remaining_destinations": destinations}

    # If it's not redundant, stop the entire stream
    logger.info(f"Stopping entire stream {stream_id}")
    stop_ffmpeg_stream(stream_id, stream_info.get("file"))
    return {"status": "stream stopped", "stream_id": stream_id}

@app.get("/stream-status/{stream_id}")
async def stream_status_endpoint(stream_id: str, api_key: str = Depends(verify_api_key)):
    if stream_id in stream_status:
        return {"stream_id": stream_id, "status": stream_status[stream_id]}
    else:
        raise HTTPException(status_code=404, detail="Stream ID not found")

@app.get("/active-streams")
async def active_streams_endpoint(api_key: str = Depends(verify_api_key)):
    active_streams_data = []
    current_time = time.time()

    # Iterate over all streams in stream_status to collect active, scheduled, and downloading streams
    for stream_id, status_info in stream_status.items():
        # Skip stopped streams
        if status_info["status"] == "Stream stopped":
            continue

        remaining_duration = 0
        remaining_delay = None
        scheduled_start_time = status_info.get("scheduled_start_time")

        # Calculate remaining duration for streaming streams
        if status_info["status"] == "Streaming" and stream_id in stream_start_time:
            elapsed_time = current_time - stream_start_time[stream_id]
            remaining_duration = max(0, status_info['remaining_duration'] - elapsed_time)

        # Collect details for all statuses including "Downloading"
        active_streams_data.append({
            "stream_id": stream_id,
            "status": status_info,
            "remaining_duration": remaining_duration,
            "remaining_delay": remaining_delay,
            "file": status_info.get("file", "Unknown"),
            "destination": status_info.get("destination", "Unknown"),
            "scheduled_start_time": scheduled_start_time  # Include scheduled start time if present
        })

    return {"active_streams": active_streams_data}





# Serve the HTML file
@app.get("/", response_class=HTMLResponse)
async def read_root():
    with open("frontend/index.html") as f:  # Adjusted to load from the root directory if needed
        return f.read()
  

app.mount("/frontend", StaticFiles(directory="frontend"), name="frontend")

@app.post("/login")
async def login(credentials: HTTPBasicCredentials = Depends(security)):
    user = users.get(credentials.username)
    if user is None or user != credentials.password:
        raise HTTPException(status_code=401, detail="Invalid credentials")
    
    # Generate a unique API key
    api_key = generate_api_key()
    # Set expiration time for 60 minutes
    expiration_time = datetime.utcnow() + timedelta(minutes=60)

    # Store the API key and expiration time
    api_keys[api_key] = expiration_time

    return {"message": "Login successful", "expiration": expiration_time.timestamp(), "api_key": api_key}

@app.get("/healthcheck")
async def healthcheck():
    return {"status": "healthy"}

# To start the FastAPI server, run this file
if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000, reload=True)
