// auth.js

const API_KEY_KEY = 'apiKey';
const LOGIN_KEY = 'isLoggedIn';
const EXPIRATION_KEY = 'loginExpiration';

// Checks if the user is logged in by comparing expiration time
function checkLoginStatus() {
    const expirationTime = localStorage.getItem(EXPIRATION_KEY);
    const now = Math.floor(Date.now() / 1000); // Convert to seconds
    if (expirationTime && now < expirationTime) {
        $('#loginModal').modal('hide');
        document.getElementById("content").style.filter = "none";
    } else {
        // Clear stored data if login has expired
        logoutUser();
        $('#loginModal').modal('show');
    }
}

// Logs in the user and stores the API key and expiration in local storage
async function loginUser(username, password) {
    try {
        const response = await fetch("http://localhost:8000/login", {
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
            localStorage.setItem(API_KEY_KEY, data.api_key);

            $('#loginModal').modal('hide');
            document.getElementById("content").style.filter = "none";
            fetchActiveStreams(); // Load active streams upon successful login
        } else {
            document.getElementById("login-error").style.display = "block";
        }
    } catch (error) {
        console.error("Login failed:", error);
    }
}

// Logs out the user by clearing local storage and showing the login modal
function logoutUser() {
    localStorage.removeItem(LOGIN_KEY);
    localStorage.removeItem(EXPIRATION_KEY);
    localStorage.removeItem(API_KEY_KEY);
    $('#loginModal').modal('show');
}

// Initialize login modal form
document.getElementById("login-form").addEventListener("submit", function(event) {
    event.preventDefault();
    const username = document.getElementById("username").value;
    const password = document.getElementById("password").value;
    loginUser(username, password);
});

document.addEventListener("DOMContentLoaded", function() {
    checkLoginStatus();
});
