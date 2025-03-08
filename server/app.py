import random
import threading
import math
import uuid
import eventlet
eventlet.monkey_patch()

from flask import Flask, request
from flask_socketio import SocketIO, emit, join_room

app = Flask(__name__)
app.config['SECRET_KEY'] = 'secret!'
socketio = SocketIO(app, async_mode='eventlet', cors_allowed_origins="*")

# In-memory dictionary to store game states by game key.
games = {}

BOARD_SIZE = 16

def create_board_state():
    """Create a new 16x16 board with corner spawns and 15% extra spawns."""
    board = []
    for r in range(BOARD_SIZE):
        row = []
        for c in range(BOARD_SIZE):
            cell = {
                "row": r,
                "col": c,
                "owner": None,         # Neutral by default.
                "troops": 0,
                "isSpawn": False,
                "spawnActive": False,
                "isCorner": False,
            }
            row.append(cell)
        board.append(row)
    
    # Set corner spawns for four teams.
    corners = [
        (0, 0, "red"),
        (0, BOARD_SIZE - 1, "blue"),
        (BOARD_SIZE - 1, 0, "green"),
        (BOARD_SIZE - 1, BOARD_SIZE - 1, "yellow")
    ]
    for r, c, team in corners:
        board[r][c]["owner"] = team
        board[r][c]["isSpawn"] = True
        board[r][c]["spawnActive"] = True
        board[r][c]["isCorner"] = True

    # Randomly select 15% of non-corner cells as extra spawns (initially inactive).
    non_corner_positions = [
        (r, c)
        for r in range(BOARD_SIZE) for c in range(BOARD_SIZE)
        if (r, c) not in [(0, 0), (0, BOARD_SIZE - 1), (BOARD_SIZE - 1, 0), (BOARD_SIZE - 1, BOARD_SIZE - 1)]
    ]
    extra_count = int(len(non_corner_positions) * 0.15)
    extra_spawns = random.sample(non_corner_positions, extra_count)
    for r, c in extra_spawns:
        board[r][c]["isSpawn"] = True
        board[r][c]["spawnActive"] = False
    return board

@app.route('/')
def home():
    # Return a simple welcome page with game rules and random game keys.
    random_keys = random.sample(
        ["apple", "banana", "cherry", "dragon", "eagle", "falcon", "grape", "honey", "igloo", "jungle"],
        5
    )
    html = """
    <html>
      <head>
        <meta charset="UTF-8">
        <title>Welcome to the Multiplayer Strategy Game</title>
      </head>
      <body>
        <h1>Welcome to the Multiplayer Strategy Game!</h1>
        <p><strong>Game Rules:</strong></p>
        <ul>
          <li>The board is 16x16 with four corner spawns.</li>
          <li>Extra (grey) spawns generate troops only after they are conquered.</li>
          <li>Click a cell with troops to select it, then click on a destination cell to move your troops.</li>
          <li>If you conquer a cell, it changes to your team's color.</li>
          <li>If you conquer your enemy's initial spawn (a corner cell), then all cells owned by that enemy become yours.</li>
          <li>All players must join using the same game link. Each player should choose a personal color and use only that color.</li>
        </ul>
        <p>Choose a game below (refresh for new keys):</p>
        <ul>
    """
    for key in random_keys:
        html += f'<li><a href="/{key}">{key.capitalize()}</a></li>'
    html += """
        </ul>
      </body>
    </html>
    """
    return html

@app.route('/<game_key>')
def game(game_key):
    if game_key not in games:
        games[game_key] = {
            "board": create_board_state(),
            "players": {},
            "moves": []
        }
        print(f"Created new game: {game_key}")
    else:
        print(f"Reusing game: {game_key}")
    return f"Game '{game_key}' is ready. Please load the client at http://localhost:5002/{game_key}."

@socketio.on('join_game')
def handle_join_game(data):
    game_key = data.get('game_key')
    player_name = data.get('player_name', 'Anonymous')
    player_team = data.get('team', 'neutral')  # New: player's chosen team
    if game_key not in games:
        games[game_key] = {
            "board": create_board_state(),
            "players": {},
            "moves": []
        }
        print(f"Created new game: {game_key}")
    # Save player's name and team.
    games[game_key]["players"][request.sid] = { "name": player_name, "team": player_team }
    join_room(game_key)
    emit('game_state', games[game_key], room=request.sid)
    print(f"Player {player_name} (team: {player_team}) joined game {game_key} (sid: {request.sid})")

@socketio.on('toggle_pause')
def handle_toggle_pause(data):
    """Handle pause/unpause requests."""
    game_key = data.get('game_key')
    if game_key not in games:
        return
    
    game = games[game_key]
    game['isPaused'] = not game.get('isPaused', False)
    socketio.emit('pause_state', {'isPaused': game['isPaused']}, room=game_key)
    print(f"Game {game_key} {'paused' if game['isPaused'] else 'resumed'}")

@socketio.on('move')
def handle_move(data):
    """Handle move requests."""
    game_key = data.get('game_key')
    if game_key not in games:
        return

    game = games[game_key]
    if game.get('isPaused', False):  # Don't process moves if game is paused
        return

    move = data
    board = game["board"]

    # Retrieve the player's information.
    player = game["players"].get(request.sid)
    if not player:
        print("Player not found for sid:", request.sid)
        return

    # Check if the player's chosen team matches the move's team.
    if player.get("team") != move.get("team"):
        print(f"Move rejected: player's team ({player.get('team')}) does not match move team ({move.get('team')}).")
        return

    from_row = move['from']['row']
    from_col = move['from']['col']
    to_row = move['to']['row']
    to_col = move['to']['col']
    attacking_troops = move["troops"]
    attacking_team = move["team"]

    from_cell = board[from_row][from_col]
    to_cell = board[to_row][to_col]

    # Remove troops from the source cell immediately.
    from_cell["troops"] = 0

    # Calculate Euclidean distance and duration.
    dx = to_col - from_col
    dy = to_row - from_row
    distance = math.sqrt(dx*dx + dy*dy)
    duration = distance * 1000  # 1 second per cell

    # Generate a unique move ID.
    move_id = str(uuid.uuid4())
    move["id"] = move_id

    # Emit a start_move event with move data and duration.
    socketio.emit('start_move', {"move": move, "duration": duration}, room=game_key)
    print(f"Emitted start_move for game {game_key} with move_id {move_id} and duration {duration} ms.")

    def process_move():
        eventlet.sleep(duration / 1000.0)
        # Don't process the move if the game is paused
        if games[game_key].get('isPaused', False):
            eventlet.sleep(0.1)  # Sleep briefly and check again
            return process_move()  # Recursively check until unpaused
            
        # Process the move.
        if to_cell["owner"] is None:
            to_cell["owner"] = attacking_team
            to_cell["troops"] = attacking_troops
            if to_cell["isSpawn"] and not to_cell["spawnActive"]:
                to_cell["spawnActive"] = True
        elif to_cell["owner"] == attacking_team:
            to_cell["troops"] += attacking_troops
        else:
            defending_troops = to_cell["troops"]
            if attacking_troops > defending_troops:
                remaining = attacking_troops - defending_troops
                defeated_team = to_cell["owner"]
                to_cell["owner"] = attacking_team
                to_cell["troops"] = remaining
                if to_cell["isSpawn"] and not to_cell["spawnActive"]:
                    to_cell["spawnActive"] = True
                if to_cell["isCorner"]:
                    for row in board:
                        for cell in row:
                            if cell.get("owner") == defeated_team:
                                cell["owner"] = attacking_team
                                if cell["isSpawn"]:
                                    cell["spawnActive"] = True
            elif attacking_troops < defending_troops:
                to_cell["troops"] = defending_troops - attacking_troops
            else:
                to_cell["troops"] = 0
                to_cell["owner"] = None

        game["moves"].append(move)
        # Emit end_move event with move_id and updated game state.
        socketio.emit('end_move', {"move_id": move_id, "state": game}, room=game_key)
        print(f"Emitted end_move for game {game_key} with move_id {move_id}.")
    eventlet.spawn(process_move)

def generate_troops():
    """Background thread that updates troop counts and sends updates each second."""
    while True:
        for game_key, game in games.items():
            if not game.get('isPaused', False):  # Only generate troops if game is not paused
                board = game["board"]
                for row in board:
                    for cell in row:
                        if cell["isSpawn"] and cell["spawnActive"]:
                            cell["troops"] += 1
                socketio.emit('game_state', game, room=game_key)
                print(f"Updated troops for game {game_key}")
        socketio.sleep(1)

if __name__ == '__main__':
    troop_thread = threading.Thread(target=generate_troops)
    troop_thread.daemon = True
    troop_thread.start()
    socketio.run(app, host='0.0.0.0', port=5001, debug=True)
