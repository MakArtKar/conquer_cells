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

TEAMS = ["red", "blue", "green", "yellow", "purple", "cyan"]
MIN_PLAYERS = 2
MAX_PLAYERS = len(TEAMS)
DEFAULT_PLAYERS = 4
SPAWN_SHARE = 0.15  # Share of each player's cells that become extra spawns.

def clamp_players(num_players):
    """Convert a requested player count to a supported one."""
    try:
        num_players = int(num_players)
    except (TypeError, ValueError):
        return DEFAULT_PLAYERS
    return min(max(num_players, MIN_PLAYERS), MAX_PLAYERS)

# Grid sizes, chosen for about 50-60 cells per player.
SQUARE_SIZE = {2: 11, 4: 15}  # Cells per side.
TRIANGLE_SIZE = 13            # Cells per side.
PENTAGON_SIZE = 7             # Cells per side of each of the 5 kites.
HEXAGON_RADIUS = 10           # Steps from the center cell to a corner cell.

def regular_polygon(sides, radius, start_angle, center=(0.0, 0.0)):
    """Corners of a regular polygon, by increasing angle (clockwise on screen, where y points down)."""
    return [
        (center[0] + radius * math.cos(start_angle + 2 * math.pi * i / sides),
         center[1] + radius * math.sin(start_angle + 2 * math.pi * i / sides))
        for i in range(sides)
    ]

def lerp(p, q, t):
    return (p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t)

def square_grid(size):
    """A size x size grid of unit squares; corners start at the top right."""
    half = size / 2
    cells = [
        [(c - half, r - half), (c + 1 - half, r - half), (c + 1 - half, r + 1 - half), (c - half, r + 1 - half)]
        for r in range(size) for c in range(size)
    ]
    return cells, regular_polygon(4, half * math.sqrt(2), -math.pi / 4)

def triangle_grid(size):
    """An equilateral triangle (corner at the top) cut into size^2 triangles with side sqrt(3)."""
    top, right, left = regular_polygon(3, size, -math.pi / 2)

    def point(a, b):
        # a steps from the top corner toward the bottom left one, b steps toward the bottom right one.
        return (top[0] + (a * (left[0] - top[0]) + b * (right[0] - top[0])) / size,
                top[1] + (a * (left[1] - top[1]) + b * (right[1] - top[1])) / size)

    cells = []
    for a in range(size):
        for b in range(size - a):
            cells.append([point(a, b), point(a, b + 1), point(a + 1, b)])  # Pointing up.
            if a + b + 1 < size:
                cells.append([point(a, b + 1), point(a + 1, b + 1), point(a + 1, b)])  # Pointing down.
    return cells, [top, right, left]

def pentagon_grid(size):
    """A regular pentagon (corner at the top) cut into 5 kites (center, side midpoint, corner,
    side midpoint), each a size x size grid of quadrilaterals."""
    corners = regular_polygon(5, 1.0, -math.pi / 2)
    midpoints = [lerp(corners[i], corners[(i + 1) % 5], 0.5) for i in range(5)]
    cells = []
    for i in range(5):
        center, start, corner, end = (0.0, 0.0), midpoints[i - 1], corners[i], midpoints[i]

        def point(s, t):
            return lerp(lerp(center, start, s), lerp(end, corner, s), t)

        for a in range(size):
            for b in range(size):
                cells.append([point(a / size, b / size), point((a + 1) / size, b / size),
                              point((a + 1) / size, (b + 1) / size), point(a / size, (b + 1) / size)])
    return cells, corners

def hexagon_grid(radius):
    """Pointy-top hexagons (distance 1 between neighbors) within radius steps of the center cell.
    The board is a hexagon with jagged sides; its corner cells are at 0, 60, ..., 300 degrees."""
    cells = []
    for q in range(-radius, radius + 1):
        for r in range(max(-radius, -q - radius), min(radius, radius - q) + 1):
            center = (q + r / 2, r * math.sqrt(3) / 2)
            cells.append(regular_polygon(6, 1 / math.sqrt(3), math.pi / 6, center))
    return cells, regular_polygon(6, radius, 0)

def board_grid(num_players):
    """Return (cell corner lists, board corners) for the player count; bases go to the board corners."""
    if num_players in SQUARE_SIZE:
        # There is no regular 2-gon: two players get a square with bases in opposite corners.
        return square_grid(SQUARE_SIZE[num_players])
    if num_players == 3:
        return triangle_grid(TRIANGLE_SIZE)
    if num_players == 5:
        # Regular pentagons do not tile, so the pentagon is a grid of quadrilaterals.
        return pentagon_grid(PENTAGON_SIZE)
    return hexagon_grid(HEXAGON_RADIUS)

def create_board_state(num_players):
    """Create the board for num_players: a grid with one base per player in the corners.

    Cells are grouped into orbits: sets of cells that rotating the board by 360/num_players
    degrees moves into each other. Spawns are chosen as whole orbits, so every player gets the
    same layout. Returns (cells, cell corner lists); coordinates are in cells, with the center at
    (0, 0) and a median distance of 1 between neighboring cells.
    """
    shapes, corners = board_grid(num_players)
    centers = [(sum(x for x, _ in shape) / len(shape), sum(y for _, y in shape) / len(shape)) for shape in shapes]

    # Scale so that moves take about 1 second per cell on every board.
    nearest = sorted(min(math.dist(p, q) for q in centers if q is not p) for p in centers)
    scale = 1 / nearest[len(nearest) // 2]
    centers = [(x * scale, y * scale) for x, y in centers]
    shapes = [[(x * scale, y * scale) for x, y in shape] for shape in shapes]
    corners = [(x * scale, y * scale) for x, y in corners]

    def closest_cell(point):
        return min(range(len(centers)), key=lambda i: math.dist(point, centers[i]))

    angle = 2 * math.pi / num_players
    turned = []  # Cell that each cell moves to when the board turns by one player.
    for x, y in centers:
        target = (x * math.cos(angle) - y * math.sin(angle), x * math.sin(angle) + y * math.cos(angle))
        cell_id = closest_cell(target)
        assert math.dist(target, centers[cell_id]) < 1e-6, "board is not symmetric"
        turned.append(cell_id)

    orbits = []  # orbit[p] is the cell that p turns move orbit[0] to.
    in_orbit = set()
    for cell_id in range(len(centers)):
        if cell_id in in_orbit:
            continue
        orbit = [cell_id]
        while turned[orbit[-1]] != cell_id:
            orbit.append(turned[orbit[-1]])
        in_orbit.update(orbit)
        orbits.append(orbit)

    cells = [
        {
            "id": cell_id,
            "x": round(x, 4),
            "y": round(y, 4),
            "owner": None,         # Neutral by default.
            "troops": 0,
            "isSpawn": False,
            "spawnActive": False,
            "isBase": False,
            "originalTeam": None,
        }
        for cell_id, (x, y) in enumerate(centers)
    ]

    first_base = closest_cell(corners[0])
    base_orbit = next(orbit for orbit in orbits if first_base in orbit)
    base_orbit = base_orbit[base_orbit.index(first_base):] + base_orbit[:base_orbit.index(first_base)]
    for team, cell_id in zip(TEAMS[:num_players], base_orbit):
        cells[cell_id].update(owner=team, isSpawn=True, spawnActive=True, isBase=True, originalTeam=team)

    # Orbits with fewer cells than players are at the center.
    full_orbits = [orbit for orbit in orbits if len(orbit) == num_players and orbit is not base_orbit]
    for orbit in random.sample(full_orbits, int(len(full_orbits) * SPAWN_SHARE)):
        for cell_id in orbit:
            cells[cell_id]["isSpawn"] = True
    center_cells = [orbit[0] for orbit in orbits if len(orbit) == 1]
    if center_cells and random.random() < 0.5:  # 50% chance to add a center spawn
        cells[center_cells[0]]["isSpawn"] = True

    return cells, [[[round(x, 4), round(y, 4)] for x, y in shape] for shape in shapes]

def create_game(num_players):
    board, shapes = create_board_state(num_players)
    return {
        "numPlayers": num_players,
        "teams": TEAMS[:num_players],
        "layout": {"cells": shapes},  # Static, so only sent when a player joins.
        "board": board,
        "players": {},
        "moves": []
    }

def without_layout(game):
    """Game state for the frequent updates: everything except the static cell shapes."""
    return {key: value for key, value in game.items() if key != "layout"}

def get_or_create_game(game_key, num_players=DEFAULT_PLAYERS):
    """Return the game; a new game uses num_players, an existing one keeps its own count."""
    if game_key not in games:
        num_players = clamp_players(num_players)
        games[game_key] = create_game(num_players)
        print(f"Created new {num_players}-player game: {game_key}")
    return games[game_key]

@app.route('/')
def home():
    # Return a welcome page with game rules, random game keys, and fairness options.
    random_keys = random.sample(
        ["apple", "banana", "cherry", "dragon", "eagle", "falcon", "grape", "honey", "igloo", "jungle"],
        5
    )
    html = """
    <html>
      <head>
        <meta charset="UTF-8">
        <title>Welcome to the Multiplayer Strategy Game</title>
        <style>
          body {
            font-family: Arial, sans-serif;
            max-width: 800px;
            margin: 0 auto;
            padding: 20px;
          }
          .settings-section {
            background-color: #f5f5f5;
            padding: 15px;
            border-radius: 5px;
            margin: 20px 0;
          }
          .settings-table {
            width: 100%;
            border-collapse: collapse;
          }
          .settings-table td {
            padding: 8px;
            border-bottom: 1px solid #ddd;
          }
          h2 {
            color: #333;
          }
        </style>
      </head>
      <body>
        <h1>Welcome to the Multiplayer Strategy Game!</h1>
        <p><strong>Game Rules:</strong></p>
        <ul>
          <li>Choose 2 to 6 players. The board is a polygon grid with one base per player in its corners: squares for 2 and 4 players, triangles for 3, a pentagon of quadrilaterals for 5, hexagons for 6.</li>
          <li>Extra (grey) spawns generate troops only after they are conquered.</li>
          <li>Click a cell with troops to select it, then click on a destination cell to move your troops.</li>
          <li>If you conquer a cell, it changes to your team's color.</li>
          <li>If you conquer your enemy's base, then all cells owned by that enemy become yours.</li>
          <li>All players must join using the same game link. Each player should choose a personal color and use only that color.</li>
        </ul>
        
        <div class="settings-section">
          <h2>Game Fairness Features</h2>
          <p>These settings help ensure all players have a fair chance:</p>
          <table class="settings-table">
            <tr>
              <td><strong>Perfect Rotational Symmetry</strong></td>
              <td>Spawn points are randomly generated in one player's part of the board and then rotated to all other parts, ensuring perfect symmetry and fairness for all teams.</td>
            </tr>
            <tr>
              <td><strong>Random Board Layout</strong></td>
              <td>Each game has a unique board layout while maintaining perfect symmetry between all players.</td>
            </tr>
          </table>
        </div>
        
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
    get_or_create_game(game_key, request.args.get('players', DEFAULT_PLAYERS))
    return f"Game '{game_key}' is ready. Please load the client at http://localhost:5002/{game_key}."

@socketio.on('game_info')
def handle_game_info(data):
    """Return the player count and teams of a game, or of the game that join_game would create."""
    game = games.get(data.get('game_key'))
    num_players = game["numPlayers"] if game else clamp_players(data.get('players', DEFAULT_PLAYERS))
    return {"numPlayers": num_players, "teams": TEAMS[:num_players]}

@socketio.on('join_game')
def handle_join_game(data):
    game_key = data.get('game_key')
    player_name = data.get('player_name', 'Anonymous')
    player_team = data.get('team', 'neutral')  # New: player's chosen team
    get_or_create_game(game_key, data.get('players', DEFAULT_PLAYERS))
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

    from_id = move.get('from')
    to_id = move.get('to')
    if not all(isinstance(cell_id, int) and 0 <= cell_id < len(board) for cell_id in (from_id, to_id)):
        print(f"Move rejected: invalid cell ids. From: {from_id} To: {to_id}")
        return
    attacking_troops = move["troops"]
    attacking_team = move["team"]

    from_cell = board[from_id]
    to_cell = board[to_id]

    # Prevent moves from or to white cells (non-spawn cells without an owner)
    if (from_cell["owner"] is None and not from_cell["isSpawn"]) or (to_cell["owner"] is None and not to_cell["isSpawn"]):
        print(f"Move rejected: can't move from/to white cell. From: {from_id} To: {to_id}")
        return

    # Remove troops from the source cell immediately.
    from_cell["troops"] = 0

    # Calculate Euclidean distance and duration.
    distance = math.hypot(to_cell["x"] - from_cell["x"], to_cell["y"] - from_cell["y"])
    duration = distance * 1000  # 1 second per cell

    # Generate a unique move ID.
    move_id = str(uuid.uuid4())
    move["id"] = move_id

    # Emit a start_move event with move data and duration.
    socketio.emit('start_move', {"move": move, "duration": duration}, room=game_key)
    print(f"Emitted start_move for game {game_key} with move_id {move_id} and duration {duration} ms.")

    def process_move():
        eventlet.sleep(duration / 1000.0)
        # Drop the move if the game was finished (or finished and created again) meanwhile
        if games.get(game_key) is not game:
            return
        # Don't process the move if the game is paused
        if game.get('isPaused', False):
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
                if to_cell["isBase"] and to_cell["originalTeam"] == defeated_team:
                    for cell in board:
                        if cell.get("owner") == defeated_team:
                            cell["owner"] = attacking_team
                            if cell["isSpawn"]:
                                cell["spawnActive"] = True
            elif attacking_troops < defending_troops:
                to_cell["troops"] = defending_troops - attacking_troops
            else:
                to_cell["troops"] = 0
                to_cell["owner"] = None
                to_cell["spawnActive"] = False

        game["moves"].append(move)
        # Emit end_move event with move_id and updated game state.
        socketio.emit('end_move', {"move_id": move_id, "state": without_layout(game)}, room=game_key)
        print(f"Emitted end_move for game {game_key} with move_id {move_id}.")
    eventlet.spawn(process_move)

def generate_troops():
    """Background thread that updates troop counts and sends updates each second."""
    while True:
        for game_key, game in list(games.items()):  # Use list() to avoid RuntimeError from dict changing size during iteration
            if not game.get('isPaused', False):  # Only generate troops if game is not paused
                for cell in game["board"]:
                    if cell["isSpawn"] and cell["spawnActive"]:
                        cell["troops"] += 1
                socketio.emit('game_state', without_layout(game), room=game_key)
                print(f"Updated troops for game {game_key}")
        socketio.sleep(1)

@socketio.on('finish_game')
def handle_finish_game(data):
    """Handle game finish requests by cleaning up the game state."""
    game_key = data.get('game_key')
    if game_key not in games:
        return

    # Delete the game state
    del games[game_key]
    print(f"Game {game_key} finished and cleaned up")
    
    # Notify all clients in the room that the game is finished
    socketio.emit('game_finished', room=game_key)

if __name__ == '__main__':
    troop_thread = threading.Thread(target=generate_troops)
    troop_thread.daemon = True
    troop_thread.start()
    socketio.run(app, host='0.0.0.0', port=5001, debug=True)
