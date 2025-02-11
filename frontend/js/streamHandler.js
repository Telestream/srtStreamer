// streamHandler.js

// Fetches active streams from the server and updates the UI
async function fetchActiveStreams() {
    const apiKey = localStorage.getItem(API_KEY_KEY);
    try {
        const response = await fetch('http://localhost:8000/active-streams', {
            headers: {
                'x-api-key': apiKey
            }
        });

        if (response.ok) {
            const data = await response.json();
            updateStreamCards(data.active_streams);
        } else {
            console.error('Failed to fetch active streams:', response.status);
        }
    } catch (error) {
        console.error("Error fetching active streams:", error);
    }
}

// Sends a request to start a new stream
async function startStream(event) {
    event.preventDefault();

    const start_offset = parseInt(document.getElementById('delay_seconds').value) || 0;
    const file = document.getElementById('file').value;
    const duration = parseInt(document.getElementById('duration').value);
    const destination = document.getElementById('destination').value;
    const inputType = document.getElementById('inputType').value;
    const streamUrl = document.getElementById('streamUrl').value;

    const apiKey = localStorage.getItem(API_KEY_KEY);

    const requestBody = {
        input_type: inputType,
        file: inputType === 'file' ? file : null,
        stream_url: inputType === 'url' ? streamUrl : null,
        duration,
        destination,
        start_offset
    };

    try {
        const response = await fetch('http://localhost:8000/start-stream', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey
            },
            body: JSON.stringify(requestBody)
        });

        if (response.ok) {
            const data = await response.json();
            console.log('Stream started:', data);
            $('#startStreamModal').modal('hide');
            fetchActiveStreams();
        } else {
            console.error('Failed to start stream:', response.status);
        }
    } catch (error) {
        console.error("Error starting stream:", error);
    }
}

// Sends a request to stop a stream
async function stopStream(streamId) {
    const apiKey = localStorage.getItem(API_KEY_KEY);

    try {
        const response = await fetch(`http://localhost:8000/stop-stream/${streamId}`, {
            method: 'POST',
            headers: {
                'x-api-key': apiKey
            }
        });

        if (response.ok) {
            console.log(`Stream ${streamId} stopped`);
            fetchActiveStreams(); // Refresh streams list
        } else {
            console.error(`Failed to stop stream ${streamId}:`, response.status);
        }
    } catch (error) {
        console.error(`Error stopping stream ${streamId}:`, error);
    }
}



// Initialize start stream form
document.getElementById('start-stream-form').addEventListener('submit', startStream);

