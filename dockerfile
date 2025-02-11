# Use Python base image
FROM python:3.13-slim 

# Install FFmpeg
RUN apt-get update && apt-get install -y ffmpeg

# Set the working directory
WORKDIR /app

# Copy project files
COPY . .

# Copy media files into the container
COPY media /app/media

# Install dependencies
RUN pip install fastapi uvicorn requests python-dotenv boto3 python-multipart

# Expose the application portS
EXPOSE 8000


# Run the FastAPI application
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--reload"]
