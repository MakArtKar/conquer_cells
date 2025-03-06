from flask import Flask, render_template, request
from flask_socketio import SocketIO, emit
import threading
import time

app = Flask(__name__)
app.config['SECRET_KEY'] = 'secret!'
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='eventlet')

# Global game state (for demonstration purposes)
game_state = {
    "players": {},
    "moves": []  # List to record move events
}

@app.route('/')
def index():
    return render_template('index.html')

@socketio.on('connect')
def handle_connect():
    print(f'Client connected: {request.sid}')
    # Initialize player state for this client
    game_state["players"][request.sid] = {"score": 0, "last_move": None}
    # Send the updated game state to all connected clients
    emit('game_state', game_state, broadcast=True)

@socketio.on('disconnect')
def handle_disconnect():
    print(f'Client disconnected: {request.sid}')
    if request.sid in game_state["players"]:
        del game_state["players"][request.sid]
    emit('game_state', game_state, broadcast=True)

@socketio.on('move')
def handle_move(data):
    """
    Expected data format:
    {
      "from": {"row": 0, "col": 0},
      "to": {"row": 1, "col": 1},
      "troops": 10,
      "team": "red"
    }
    """
    print(f"Received move from {request.sid}: {data}")
    # Record the move in the game state
    game_state["moves"].append(data)
    # Update the player's state (optional)
    if request.sid in game_state["players"]:
        game_state["players"][request.sid]["last_move"] = data
    # Broadcast the move to all clients
    emit('move', data, broadcast=True)

def spawn_troops():
    """
    Background thread to simulate troop generation every second.
    You can extend this to update your game logic.
    """
    while True:
        for sid in game_state["players"]:
            game_state["players"][sid]["score"] += 1
        socketio.emit('game_state', game_state)
        time.sleep(1)

if __name__ == '__main__':
    # Start the background troop generation thread
    thread = threading.Thread(target=spawn_troops)
    thread.daemon = True
    thread.start()
    # Run the Flask-SocketIO server on all available interfaces
    socketio.run(app, host="0.0.0.0", port=5001, debug=True)
