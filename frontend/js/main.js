const API_KEY_KEY = 'apiKey'; 
const LOGIN_KEY = 'isLoggedIn';
const EXPIRATION_KEY = 'loginExpiration';
let currentStreams = []; // Global variable to store active streams

// Determine the base URL dynamically
const baseURL = window.location.origin.includes("localhost") 
    ? "http://localhost:8000" 
    : window.location.origin;  // Uses current domain for deployed environments

async function loadComponent(url, containerId) {
    const response = await fetch(url);
    const componentHTML = await response.text();
    document.getElementById(containerId).innerHTML = componentHTML;

    // Ensure that the modal is initialized correctly
    $('#loginModal').modal({ show: false });
    $('#startStreamModal').modal({ show: false });
}

function checkLoginStatus() {
    const expirationTime = localStorage.getItem(EXPIRATION_KEY);
    const now = Math.floor(Date.now() / 1000); // Convert to seconds
    const isLoggedIn = localStorage.getItem(LOGIN_KEY);

    if (isLoggedIn && expirationTime && now < expirationTime) {
        $('#loginModal').modal('hide'); // Hide the modal if logged in
        document.getElementById("content").style.filter = "none"; // Remove grayscale effect
        fetchActiveStreams(); // Fetch streams only if logged in
    } else {
        $('#loginModal').modal('show'); // Show login modal if not logged in
    }
}

document.addEventListener("DOMContentLoaded", function() {
    loadComponent('frontend/components/loginModal.html', 'loginModalContainer')
        .then(() => loadComponent('frontend/components/startStreamModal.html', 'startStreamModalContainer'))
        .then(() => {
            checkLoginStatus(); // Check login status after loading components
            // Add start stream form submit listener here after the modal has loaded
            document.getElementById('start-stream-form').addEventListener('submit', startStream);
        });
});

// Handle Login Form Submission
document.addEventListener('submit', async function(event) {
    if (event.target.id === 'login-form') {
        event.preventDefault();
        const username = document.getElementById("username").value;
        const password = document.getElementById("password").value;

        const response = await fetch(`${baseURL}/login`, {
            method: "POST",
            headers: {
                "Authorization": "Basic " + btoa(username + ":" + password),
                "Content-Type": "application/json"
            }
        });

        if (response.ok) {
            const data = await response.json();
            localStorage.setItem(LOGIN_KEY, 'true');
            localStorage.setItem(EXPIRATION_KEY, data.expiration);
            localStorage.setItem(API_KEY_KEY, data.api_key); // Store API key

            $('#loginModal').modal('hide'); // Hide modal on successful login
            document.getElementById("content").style.filter = "none"; // Remove grayscale effect
            fetchActiveStreams(); // Fetch streams after login
        } else {
            document.getElementById("login-error").style.display = "block"; // Show error
        }
    }
});

// Fetch Active Streams and Update the UI
async function fetchActiveStreams() {
    const apiKey = localStorage.getItem(API_KEY_KEY);
    try {
        const response = await fetch(`${baseURL}/active-streams`, {
            headers: { 'x-api-key': apiKey }
        });

        if (response.ok) {
            const data = await response.json();
            currentStreams = data.active_streams; // Store streams in global variable
            updateStreamCards(currentStreams);
        } else {
            console.error('Failed to fetch active streams:', response.status);
            document.getElementById('stream-container').innerHTML = '<p>No active streams available.</p>';
        }
    } catch (error) {
        console.error("Error fetching active streams:", error);
    }
}

// Update Stream Cards in the UI
// Update Stream Cards in the UI with Bandwidth Data
async function updateStreamCards(streams) {
    const streamContainer = document.getElementById('stream-container');
    streamContainer.innerHTML = '';

    if (streams.length === 0) {
        streamContainer.innerHTML = '<p>No active streams available.</p>';
        return;
    }

    streams.forEach(async (stream) => {
        const delayDisplay = stream.status.status === "Scheduled" 
            ? `<p>Starting at: ${stream.status.scheduled_start_time}</p>` 
            : (stream.status.status === "Downloading")
            ? `<p>Downloading file...</p>` 
            : (stream.status.remaining_delay > 0)
            ? `<p>Starting in: ${stream.status.remaining_delay} seconds</p>` 
            : "";

        const errorMessage = (stream.status.status === "Error" && stream.status.message) 
            ? `<p class="text-danger">Error: ${stream.status.message}</p>` 
            : "";

        const isRedundant = stream.status.redundant ? "Yes" : "No";
        const stopRandomButton = stream.status.redundant ? 
            `<button class="btn btn-secondary mt-2" onclick="stopRandomSource('${stream.stream_id}')">Disable One Stream</button>` 
            : '';
        
        let destinationDisplay = '';
        if (Array.isArray(stream.status.destination)) {
            destinationDisplay = stream.status.destination.map(dest => 
                `<p>${dest} <span class="bandwidth" data-stream-id="${stream.stream_id}" data-destination="${dest}">Loading...</span> Mbps</p>`
            ).join("");
        } else if (typeof stream.status.destination === "string" && stream.status.destination.includes(",")) {
            const destinations = stream.status.destination.split(",");
            destinationDisplay = destinations.map(dest => 
                `<p>${dest.trim()} <span class="bandwidth" data-stream-id="${stream.stream_id}" data-destination="${dest.trim()}">Loading...</span> Mbps</p>`
            ).join("");
        } else {
            destinationDisplay = `<p>${stream.status.destination} <span class="bandwidth" data-stream-id="${stream.stream_id}" data-destination="${stream.status.destination}">Loading...</span> Mbps</p>`;
        }

        const card = document.createElement('div');
        card.className = 'col-md-4 mb-3';
        card.innerHTML = `
            <div class="card" data-stream-id="${stream.stream_id}">
                <div class="card-body">
                    <h5 class="card-title">Stream ID: ${stream.stream_id}</h5>
                    <p><strong>Status:</strong> ${stream.status.status}</p>
                    ${delayDisplay}
                    <p><strong>Redundant:</strong> ${isRedundant}</p>
                    <p><strong>Destination(s) & Bandwidth:</strong></p>
                    ${destinationDisplay}
                    <p><strong>File:</strong> ${stream.file}</p>
                    <p><strong>Remaining Duration:</strong> ${Math.floor(stream.remaining_duration)} seconds</p>
                    ${errorMessage}
                    <button class="btn btn-danger mt-2" onclick="stopStream('${stream.stream_id}')">Stop Stream</button>
                    ${stopRandomButton}
                </div>
            </div>
        `;
        streamContainer.appendChild(card);

        // Fetch and update bandwidth for this stream
        fetchBandwidth(stream.stream_id);
    });
}

async function stopRandomSource(streamId) {
    const apiKey = localStorage.getItem(API_KEY_KEY);

    try {
        const response = await fetch(`${baseURL}/stop-random-source/${streamId}`, {
            method: 'POST',
            headers: {
                'x-api-key': apiKey
            }
        });

        if (response.ok) {
            const data = await response.json();
            console.log(`Random source stopped for stream ${streamId}:`, data);

            // Refresh stream list
            fetchActiveStreams();
        } else {
            console.error('Failed to stop random source:', response.status);
        }
    } catch (error) {
        console.error("Error stopping random source:", error);
    }
}
// Fetch and update bandwidth per stream
async function fetchBandwidth(streamId) {
    const apiKey = localStorage.getItem(API_KEY_KEY);
    console.log(`Fetching bandwidth for streamId: ${streamId}`);

    try {
        const response = await fetch(`${baseURL}/bandwidth/${streamId}`, {
            headers: { 'x-api-key': apiKey }
        });

        if (response.ok) {
            const data = await response.json();
            console.log(`Received bandwidth for stream ${streamId}:`, data);
            updateBandwidthDisplay(streamId, data.bandwidth);
        } else {
            console.error(`Failed to fetch bandwidth for stream ${streamId}:`, response.status);
        }
    } catch (error) {
        console.error(`Error fetching bandwidth for stream ${streamId}:`, error);
    }
}

// Update the bandwidth values in the UI
function updateBandwidthDisplay(streamId, bandwidthData) {
    document.querySelectorAll(`.bandwidth[data-stream-id="${streamId}"]`).forEach(span => {
        const destination = span.getAttribute("data-destination");
        if (bandwidthData[destination]) {
            span.textContent = `${bandwidthData[destination]}`;
        } else {
            span.textContent = "N/A";
        }
    });
}

// Periodically update bandwidth for all active streams
setInterval(() => {
    currentStreams.forEach(stream => {
        fetchBandwidth(stream.stream_id);
    });
}, 1000);

document.addEventListener("DOMContentLoaded", function () {
    attachUploadEventListeners();
});

function attachUploadEventListeners() {
    const uploadForm = document.getElementById("upload-file-form");
    const fileInput = document.getElementById("fileInput");
    const expireTimeInput = document.getElementById("expireTime");
    const uploadStatus = document.getElementById("upload-status");
    const progressBar = document.getElementById("uploadProgressBar");

    if (!uploadForm || !fileInput || !progressBar) {
        console.error("Upload modal elements not found.");
        return;
    }

    uploadForm.addEventListener("submit", function (event) {
        event.preventDefault();

        const file = fileInput.files[0];
        if (!file) {
            uploadStatus.innerHTML = `<p class="text-danger">Please select a file.</p>`;
            return;
        }

        const formData = new FormData();
        formData.append("file", fileInput.files[0]);

        // Ensure expire_time is sent correctly in the URL (same as cURL request)
        const expireMinutes = expireTimeInput.value.trim();
        let uploadUrl = `${baseURL}/upload`;
        if (expireMinutes !== "") {
            uploadUrl += `?expire_time=${encodeURIComponent(parseInt(expireMinutes))}`;
        }

        const apiKey = localStorage.getItem(API_KEY_KEY);
        uploadStatus.innerHTML = `<p class="text-info">Uploading...</p>`;
        
        const xhr = new XMLHttpRequest();
        xhr.open("POST", uploadUrl, true);
        

        xhr.setRequestHeader("api-key", apiKey);
        
        // Track Upload Progress
        xhr.upload.onprogress = function (event) {
            if (event.lengthComputable) {
                const percentComplete = Math.round((event.loaded / event.total) * 100);
                progressBar.style.width = percentComplete + "%";
                progressBar.textContent = percentComplete + "%";
            }
        };
        
        xhr.onload = function () {
            if (xhr.status === 200) {
                const response = JSON.parse(xhr.responseText);
                console.log("File uploaded:", response);
                uploadStatus.innerHTML = `<p class="text-success">File uploaded successfully!</p>`;
                progressBar.style.width = "100%";
                progressBar.classList.add("bg-success");
        
                // Refresh file list after upload
                loadFilesFromS3();
            } else {
                uploadStatus.innerHTML = `<p class="text-danger">Upload failed: ${xhr.statusText}</p>`;
                progressBar.classList.add("bg-danger");
            }
        };
        
        xhr.onerror = function () {
            uploadStatus.innerHTML = `<p class="text-danger">Upload error occurred.</p>`;
            progressBar.classList.add("bg-danger");
        };
        
        xhr.send(formData);
    });
}

document.addEventListener("DOMContentLoaded", function () {
    loadComponent('frontend/components/loginModal.html', 'loginModalContainer')
        .then(() => loadComponent('frontend/components/startStreamModal.html', 'startStreamModalContainer'))
        .then(() => {
            checkLoginStatus();
            attachEventListeners(); // Attach event listeners once modal is loaded
        });
});

function attachEventListeners() {
    const fileSelection = document.getElementById("fileSelection");
    const fileSelectorContainer = document.getElementById("fileSelectorContainer");
    const fileList = document.getElementById("fileList");

    if (fileSelection) {
        fileSelection.addEventListener("change", function () {
            toggleFileSelector();
        });
    }

    // Ensure correct UI state when modal opens
    $('#startStreamModal').on('show.bs.modal', function () {
        toggleFileSelector();
    });

    function toggleFileSelector() {
        if (fileSelection.value === "select") {
            fileSelectorContainer.style.display = "block"; // Show file dropdown
            loadFilesFromS3(); // Fetch S3 files
        } else {
            fileSelectorContainer.style.display = "none"; // Hide dropdown
        }
    }

    // Fetch available files from S3
    async function loadFilesFromS3() {
        const apiKey = localStorage.getItem(API_KEY_KEY);
        try {
            const response = await fetch(`${baseURL}/files`, {
                headers: { 'x-api-key': apiKey }
            });

            if (response.ok) {
                const data = await response.json();
                fileList.innerHTML = ""; // Clear previous items

                if (data.files.length > 0) {
                    data.files.forEach(file => {
                        let option = document.createElement("option");
                        option.value = file;
                        option.textContent = file;
                        fileList.appendChild(option);
                    });
                } else {
                    let option = document.createElement("option");
                    option.value = "";
                    option.textContent = "No files available";
                    option.disabled = true;
                    fileList.appendChild(option);
                }
            } else {
                console.error("Failed to load files:", response.status);
            }
        } catch (error) {
            console.error("Error fetching files:", error);
        }
    }

    // Attach form submission handler
    const startStreamForm = document.getElementById("start-stream-form");
    if (startStreamForm) {
        startStreamForm.addEventListener("submit", startStream);
    }
}

// Handle Start Stream Form Submission
async function startStream(event) {
    event.preventDefault();

    const start_offset = parseInt(document.getElementById('delay_seconds').value) || 0;
    const fileSelection = document.getElementById("fileSelection").value;
    const fileList = document.getElementById("fileList");
    const selectedFile = fileSelection === "select" ? fileList.value : null;

    const duration = parseInt(document.getElementById('duration').value);
    const primaryDestination = document.getElementById('destination').value.trim();
    const isRedundant = document.getElementById('redundant').checked;
    const secondaryDestination = document.getElementById('destination_secondary')?.value.trim() || "";

    let finalDestination = [primaryDestination];
    if (isRedundant && secondaryDestination) {
        finalDestination.push(secondaryDestination);
    }

    const apiKey = localStorage.getItem(API_KEY_KEY);

    const requestBody = {
        input_type: "file",
        file: selectedFile, // Use selected file or null for random
        duration,
        destination: finalDestination,
        start_offset,
        redundant: isRedundant
    };

    console.log("Sending request:", requestBody);

    try {
        const response = await fetch(`${baseURL}/start-stream`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey
            },
            body: JSON.stringify(requestBody)
        });

        if (response.ok) {
            const data = await response.json();
            console.log("Stream started:", data);
            $('#startStreamModal').modal('hide');
            fetchActiveStreams();
        } else {
            console.error("Failed to start stream:", response.status);
        }
    } catch (error) {
        console.error("Error starting stream:", error);
    }
}

async function stopStream(streamId) {
    const apiKey = localStorage.getItem(API_KEY_KEY); // Get API key from local storage

    // Immediately set the status to "Stopping" in the UI
    const streamCard = document.querySelector(`.card[data-stream-id="${streamId}"]`);
    if (streamCard) {
        const statusText = streamCard.querySelector(".card-text");
        if (statusText) {
            statusText.innerText = "Status: Stopping...";
        }
    }

    const response = await fetch(`${baseURL}/stop-stream/${streamId}`, {
        method: 'POST',
        headers: {
            'x-api-key': apiKey // Use the API key from local storage
        }
    });
    
    if (response.ok) {
        console.log(`Stream ${streamId} stopped.`);
        fetchActiveStreams(); // Refresh the list to confirm the stream is stopped
    } else {
        console.error('Failed to stop stream:', response.status);
    }
}




// Set interval for fetching active streams
setInterval(fetchActiveStreams, 1000);
