// ui.js

// Updates the list of active streams displayed on the UI
function updateStreamCards(streams) {
    const streamContainer = document.getElementById('stream-container');
    streamContainer.innerHTML = '';

    streams.forEach(stream => {
        const delayDisplay = (stream.status.status === "Scheduled")
            ? `<p>Starting at: ${stream.status.scheduled_start_time}</p>`
            : (stream.status.remaining_delay > 0)
                ? `<p>Starting in: ${stream.status.remaining_delay} seconds</p>`
                : "";

        const card = document.createElement('div');
        card.className = 'col-md-4 mb-3';
        card.innerHTML = `
            <div class="card" data-stream-id="${stream.stream_id}">
                <div class="card-body">
                    <h5 class="card-title">Stream ID: ${stream.stream_id}</h5>
                    <p>Status: ${stream.status.status}</p>
                    ${delayDisplay}
                    <p>File: ${stream.file}</p>
                    <p>Destination: ${stream.destination}</p>
                    <p>Remaining Duration: ${Math.floor(stream.remaining_duration)} seconds</p>
                    <button class="btn btn-danger" onclick="stopStream('${stream.stream_id}')">Stop Stream</button>
                </div>
            </div>
        `;
        streamContainer.appendChild(card);
    });
}

// Toggles visibility of file and URL input fields based on input type selection
document.getElementById('inputType').addEventListener('change', function() {
    const inputType = document.getElementById('inputType').value;
    document.getElementById('inputFileContainer').style.display = inputType === 'file' ? 'block' : 'none';
    document.getElementById('inputUrlContainer').style.display = inputType === 'url' ? 'block' : 'none';
});
