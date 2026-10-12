import random
import threading
import math
import time
import uuid
import eventlet
eventlet.monkey_patch()

from flask import Flask, request
from flask_socketio import SocketIO, join_room

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

def cell_distance(a, b):
    return math.hypot(a["x"] - b["x"], a["y"] - b["y"])

class Bot:
    """A bot plays a color without human players. The rules are the same for every bot: at most
    one move per second, and a move sends all troops of the cell, as a player's click does."""
    label = None

    def move(self, game, team, flights):
        """Return the move to start this second as (from cell id, to cell id), or None.
        flights are the moves on the way, which players see on the board: dicts with from, to,
        team, troops, aimed_at (the owner of the target cell at the start), and arrives (a
        time.monotonic() time)."""
        return None

    def attacked(self, game, team, attacker):
        """Called when troops of the attacker color land on a cell of the bot's color."""

class DummyBot(Bot):
    """Does nothing: its color keeps its base and the troops there."""
    label = "Dummy"

def free_cells(game, flights):
    """Neutral spawns that no troops are on the way to."""
    aimed = {f["to"] for f in flights}
    return [c for c in game["board"] if c["owner"] is None and c["isSpawn"] and c["id"] not in aimed]

def own_base(game, team):
    """The team's own base while the team holds it, else None (and the team has no cells)."""
    return next((c for c in game["board"] if c["isBase"] and c["originalTeam"] == team and c["owner"] == team), None)

class PeaceBot(Bot):
    """Takes free cells and never attacks. Each second: its fullest cell with more than
    SEND_HOME_ABOVE troops sends them to its base; if no cell has that many, its cell nearest to
    a free cell takes it. The base only takes free cells while no other cell has troops (at the
    start). It does not wait for earlier moves to arrive."""
    label = "Peace"
    SEND_HOME_ABOVE = 25  # Fewer, bigger moves to the base: less clutter on the board.

    def __init__(self):
        self.second = 0  # move() is called once per second of play
        self.arrivals = {}  # Free cell id -> second when our troops reach it

    def move(self, game, team, flights):
        self.second += 1
        return self.peace_move(game, team, flights)

    def peace_move(self, game, team, flights):
        """Peace's move for this second (see the class description); the second is counted already."""
        base = own_base(game, team)
        if base is None:
            return None
        others = [c for c in game["board"] if c["owner"] == team and c is not base and c["troops"] > 0]
        crowded = [c for c in others if c["troops"] > self.SEND_HOME_ABOVE]
        if crowded:
            return (max(crowded, key=lambda c: c["troops"])["id"], base["id"])
        return self.take_free_cell(game, base, others, flights)

    def take_free_cell(self, game, base, others, flights):
        """The move of our cell nearest to a free cell to that cell, or None. The base only moves
        while no other cell has troops. A free cell that other troops are on the way to is not
        free: two colors sending the same troops to one cell would tie on it again and again.
        Call once per second, after counting the second."""
        self.arrivals = {cell_id: second for cell_id, second in self.arrivals.items() if second >= self.second}
        free = [c for c in free_cells(game, flights) if c["id"] not in self.arrivals]
        sources = others or ([base] if base["troops"] > 0 else [])
        if not sources or not free:
            return None
        source, target = min(((o, f) for o in sources for f in free), key=lambda pair: cell_distance(*pair))
        self.arrivals[target["id"]] = self.second + math.ceil(cell_distance(source, target))
        return (source["id"], target["id"])

class KushchushchaBot(PeaceBot):
    """Plays like Peace until a color attacks it. Then each second its fullest cell, the base
    included, sends all troops to the base of that color, until that color has no base; then
    the next color that attacked it, or Peace again."""
    label = "Кущуща"

    def __init__(self):
        super().__init__()
        self.enemies = []  # Colors that attacked, in order

    def attacked(self, game, team, attacker):
        if attacker not in self.enemies:
            self.enemies.append(attacker)

    def move(self, game, team, flights):
        while self.enemies and own_base(game, self.enemies[0]) is None:
            self.enemies.pop(0)  # That color has lost its base.
        if not self.enemies:
            return super().move(game, team, flights)
        self.second += 1  # Keep Peace's clock for its free cell bookkeeping.
        own = [c for c in game["board"] if c["owner"] == team and c["troops"] > 0]
        if not own:
            return None
        return (max(own, key=lambda c: c["troops"])["id"], own_base(game, self.enemies[0])["id"])

class WarriorBot(PeaceBot):
    """Plays like Peace while there are free cells, then makes war on the color with the fewest
    troops until that color has neither cells nor troops on the way, then on the next one.

    A threat is a color that can attack: one a person plays, or one whose bot has attacked
    anybody. Losing the base loses all cells, so the base must hold out against RESERVE_SHARE of
    the army of every threat, counting the base's growth while the troops are on the way and the
    cells that can reinforce it in time: a color that sends everything leaves its own base empty,
    so it rarely does, and the defense below answers real attacks. Before a strike on an enemy
    base, though, that enemy has nothing to lose: it sees the strike coming and can send its
    whole army at our base before its base falls, so then the base must hold out against
    ALL_IN_SHARE of that army.

    Each second, the first of these that applies:
    1. Defend the base: if the troops on the way to it would take it, a cell that arrives in
       time sends its troops there.
    2. Defend another cell, if one cell that arrives in time is enough; else give the cell up.
    3. Peace's move, while there are free cells.
    4. Punish: a color whose troops are on the way to our base has sent them from its cells, so
       if one of our cells can take its base now, it does.
    5. Take back a cell lost in the last RETAKE_SECONDS, if one cell can do it.
    6. Keep the reserve: if the base would not hold out, the fullest cell sends its troops home.
    7. A decisive blow from the base on the enemy base, if the base would hold out empty.
    8. A strike from the staging cell (our cell nearest to the target) once it has enough troops
       (the target's troops when ours arrive, its color's troops on the way there, and a
       margin) and the base would hold out without them; else the staging cell's troops go
       home. The target is the enemy base if we can gather enough for it and the base would
       hold out, else the cheapest enemy cell; a cell that held out against two strikes is left
       alone for a while.
    9. Take a free cell that turned up (after a tie).
    10. The fullest other cell feeds the staging cell until it has enough, then the base."""
    label = "Warrior"
    MARGIN_SHARE = 0.1  # Troops over the expected defense: 10%, at least MIN_MARGIN.
    MIN_MARGIN = 3
    RESERVE_SHARE = 0.5  # The base holds out against half of a threat's army ...
    ALL_IN_SHARE = 1.2  # ... and against all of it plus 20% before we strike its base.
    MIN_FEED = 5  # Smaller groups do not feed: less clutter on the board.
    RETAKE_SECONDS = 30
    GIVE_UP_STRIKES = 2  # Failed strikes on a cell before it is left alone ...
    GIVE_UP_SECONDS = 30  # ... for this long.
    SAFETY_SECONDS = 0.3  # A reinforcement must arrive this much before the attack.

    def __init__(self):
        super().__init__()
        self.at_war = False
        self.enemy = None
        self.target = None  # Id of the enemy cell we gather troops for
        self.aggressors = set()  # Colors seen attacking anybody
        self.owned = set()  # Our cell ids a second ago
        self.lost = {}  # Cell id -> second when we lost it
        self.strikes = {}  # Target cell id -> second when our strike should have landed
        self.failures = {}  # Target cell id -> (failed strikes, second until it is left alone)

    def move(self, game, team, flights):
        self.second += 1
        board = game["board"]
        base = own_base(game, team)
        if base is None:
            return None
        fronts = [c for c in board if c["owner"] == team and c is not base]
        self.note_results(board, team, flights)
        threats = {color: self.RESERVE_SHARE for color in (self.aggressors | human_teams(game)) - {team, None}}

        move = self.defend(base, fronts, flights, team) or self.defend_cells(fronts, flights, team)
        if move:
            return move
        if not self.at_war:
            if free_cells(game, flights):
                return self.peace_move(game, team, flights)
            self.at_war = True

        enemy = self.choose_enemy(board, team, flights)
        if enemy is None:
            return None
        move = self.punish(game, team, base, fronts, flights) or self.retake(board, team, fronts, flights)
        if move:
            return move
        feeders = [c for c in fronts if c["troops"] >= self.MIN_FEED]
        go_home = (max(feeders, key=lambda c: c["troops"])["id"], base["id"]) if feeders else None
        if not self.holds_out(board, team, base, base["troops"], fronts, flights, threats):
            return go_home

        enemy_base = own_base(game, enemy)
        if (enemy_base and base["troops"] >= self.needed(enemy_base, base, flights)
                and self.holds_out(board, team, base, 0, fronts, flights, {**threats, enemy: self.ALL_IN_SHARE})):
            self.strikes[enemy_base["id"]] = self.second + math.ceil(cell_distance(base, enemy_base)) + 1
            return (base["id"], enemy_base["id"])

        target = self.choose_target(board, team, base, enemy, enemy_base, fronts, flights, threats)
        if target is None:
            return None  # The enemy has only troops on the way: wait, defense handles them.
        staging = min(fronts, key=lambda c: cell_distance(c, target))
        striking = any(f["team"] == team and f["to"] == target["id"] for f in flights)
        ready = staging["troops"] >= self.needed(target, staging, flights)
        if ready and not striking:
            rest = [c for c in fronts if c is not staging]
            risky = {**threats, enemy: self.ALL_IN_SHARE} if target is enemy_base else threats
            if self.holds_out(board, team, base, base["troops"], rest, flights, risky):
                self.strikes[target["id"]] = self.second + math.ceil(cell_distance(staging, target)) + 1
                return (staging["id"], target["id"])
            return (staging["id"], base["id"])  # The base needs these troops first.

        others = [c for c in fronts if c["troops"] > 0]
        free_move = self.take_free_cell(game, base, others, flights) if others else None
        if free_move:
            return free_move
        # The staging cell gathers what the strike needs; the rest goes home.
        feeders = [c for c in feeders if c is not staging]
        if feeders:
            return (max(feeders, key=lambda c: c["troops"])["id"], base["id"] if ready else staging["id"])
        return None

    def note_results(self, board, team, flights):
        """Remember the attackers, the cells we lost, and the strikes that did not take their target."""
        for flight in flights:
            if flight["aimed_at"] not in (None, flight["team"]):
                self.aggressors.add(flight["team"])
        owned = {c["id"] for c in board if c["owner"] == team}
        for cell_id in self.owned - owned:
            self.lost[cell_id] = self.second
        self.owned = owned
        for cell_id, landed in list(self.strikes.items()):
            if self.second >= landed:
                del self.strikes[cell_id]
                if board[cell_id]["owner"] != team:
                    count = self.failures.get(cell_id, (0, 0))[0] + 1
                    self.failures[cell_id] = (count, self.second + self.GIVE_UP_SECONDS if count >= self.GIVE_UP_STRIKES else 0)

    def defend(self, cell, fronts, flights, team, one_move_only=False):
        """A reinforcement for the cell if the enemy troops on the way to it would take it, else None.
        With one_move_only, only a cell that is enough by itself helps (else the cell is given up)."""
        now = time.monotonic()
        incoming = sorted((f for f in flights if f["to"] == cell["id"] and f["team"] != team), key=lambda f: f["arrives"])
        ours = [f for f in flights if f["to"] == cell["id"] and f["team"] == team]
        attack = 0
        for flight in incoming:
            attack += flight["troops"]
            wait = flight["arrives"] - now
            defense = cell["troops"] + math.floor(wait) + sum(f["troops"] for f in ours if f["arrives"] <= flight["arrives"])
            shortfall = attack - defense  # The cell is lost at 0 too: a tie leaves it neutral.
            if shortfall < 0:
                continue
            need = shortfall + max(self.MIN_MARGIN, math.ceil(shortfall * self.MARGIN_SHARE))
            # The fullest cell that arrives in time: a big reinforcement covers the next waves
            # too, so the next seconds are free for other moves (such as punishing the attacker).
            helpers = [c for c in fronts if c is not cell and c["troops"] > 0
                       and cell_distance(c, cell) < wait - self.SAFETY_SECONDS]
            if not helpers:
                return None  # Too late for this attack.
            helper = max(helpers, key=lambda c: c["troops"])
            if helper["troops"] >= need or not one_move_only:
                return (helper["id"], cell["id"])
            return None  # Too expensive: give the cell up.
        return None

    def defend_cells(self, fronts, flights, team):
        for cell in fronts:
            move = self.defend(cell, fronts, flights, team, one_move_only=True)
            if move:
                return move
        return None

    def holds_out(self, board, team, base, troops, fronts, flights, threats):
        """Whether the base, with that many troops and these cells to reinforce it, holds out
        against each threat color's army times its share (threats: color -> share; see the
        class description)."""
        if troops < base["troops"] and any(f["to"] == base["id"] and f["team"] != team for f in flights):
            return False  # Do not empty the base while enemy troops are on the way to it.
        for color, share in threats.items():
            cells = [c for c in board if c["owner"] == color]
            army = sum(c["troops"] for c in cells) + sum(f["troops"] for f in flights if f["team"] == color)
            if army == 0:
                continue
            # The bulk of an army is usually on its fullest cell; its way to our base is the time
            # our base has to grow and to be reinforced.
            distance = cell_distance(max(cells, key=lambda c: c["troops"]), base) if cells else 0
            helpers = sorted((c["troops"] for c in fronts if cell_distance(c, base) < distance - 1), reverse=True)
            reinforcement = sum(helpers[:max(0, math.floor(distance) - 1)])
            if troops + math.floor(distance) + reinforcement < army * share:
                return False
        return True

    def punish(self, game, team, base, fronts, flights):
        """A strike on the base of a color whose troops are on the way to our base, if one cell can take it."""
        for color in {f["team"] for f in flights if f["to"] == base["id"] and f["team"] != team}:
            enemy_base = own_base(game, color)
            if enemy_base is None or any(f["team"] == team and f["to"] == enemy_base["id"] for f in flights):
                continue
            able = [c for c in fronts if c["troops"] >= self.needed(enemy_base, c, flights)]
            if able:
                source = min(able, key=lambda c: cell_distance(c, enemy_base))
                self.strikes[enemy_base["id"]] = self.second + math.ceil(cell_distance(source, enemy_base)) + 1
                return (source["id"], enemy_base["id"])
        return None

    def retake(self, board, team, fronts, flights):
        """A strike on a cell we lost in the last RETAKE_SECONDS, if one cell can take it back."""
        best = None
        for cell_id, lost_at in list(self.lost.items()):
            cell = board[cell_id]
            if self.second - lost_at > self.RETAKE_SECONDS or cell["owner"] in (None, team):
                del self.lost[cell_id]
                continue
            if any(f["team"] == team and f["to"] == cell_id for f in flights):
                continue
            for source in fronts:
                if source["troops"] >= self.needed(cell, source, flights):
                    distance = cell_distance(source, cell)
                    if best is None or distance < best[0]:
                        best = (distance, source, cell)
        if best is None:
            return None
        distance, source, cell = best
        self.strikes[cell["id"]] = self.second + math.ceil(distance) + 1
        return (source["id"], cell["id"])

    def choose_enemy(self, board, team, flights):
        """The color we make war on: the one with the fewest troops, kept until it has neither
        cells nor troops on the way."""
        if self.enemy is not None and (any(c["owner"] == self.enemy for c in board)
                                       or any(f["team"] == self.enemy for f in flights)):
            return self.enemy
        totals = {}
        for cell in board:
            if cell["owner"] not in (None, team):
                totals[cell["owner"]] = totals.get(cell["owner"], 0) + cell["troops"]
        for flight in flights:
            if flight["team"] in totals:
                totals[flight["team"]] += flight["troops"]
        self.enemy = min(totals, key=totals.get) if totals else None
        self.target = None
        return self.enemy

    def choose_target(self, board, team, base, enemy, enemy_base, fronts, flights, threats):
        """The enemy cell to gather troops for (see the class description), or None."""
        def left_alone(cell):
            count, until = self.failures.get(cell["id"], (0, 0))
            return count >= self.GIVE_UP_STRIKES and self.second < until

        candidates = [c for c in board if c["owner"] == enemy]
        if not candidates:
            return None
        allowed = [c for c in candidates if not left_alone(c)] or candidates
        gatherable = sum(c["troops"] for c in fronts)

        def cost(cell):
            return self.needed(cell, min(fronts, key=lambda c: cell_distance(c, cell)), flights)

        current = board[self.target] if self.target is not None else None
        base_possible = False
        if enemy_base is not None and any(c is enemy_base for c in allowed) and cost(enemy_base) <= gatherable:
            staging = min(fronts, key=lambda c: cell_distance(c, enemy_base))
            rest = [c for c in fronts if c is not staging]
            base_possible = self.holds_out(board, team, base, base["troops"], rest, flights, {**threats, enemy: self.ALL_IN_SHARE})
        if base_possible:
            current = enemy_base
        elif current is None or not any(c is current for c in allowed) or cost(current) > gatherable:
            others = [c for c in allowed if c is not enemy_base]
            current = min(others or allowed, key=cost)
        self.target = current["id"]
        return current

    def needed(self, target, source, flights):
        """Troops that the source cell must send to take the target cell."""
        travel = cell_distance(source, target)
        defense = target["troops"] + math.ceil(travel)  # An owned cell gains 1 troop per second.
        now = time.monotonic()
        for flight in flights:
            if flight["to"] == target["id"] and flight["team"] == target["owner"] and flight["arrives"] - now <= travel:
                defense += flight["troops"]
        return defense + max(self.MIN_MARGIN, math.ceil(defense * self.MARGIN_SHARE))

# Bot classes by kind. A color without human players is played by the bot chosen for it in the
# lobby; each game creates its own bot objects, so bots can keep state between seconds.
BOTS = {"dummy": DummyBot, "peace": PeaceBot, "kushchushcha": KushchushchaBot, "warrior": WarriorBot}
DEFAULT_BOT = "dummy"
BOT_OPTIONS = [{"kind": kind, "label": bot.label} for kind, bot in BOTS.items()]

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

def new_map(game, num_players):
    """Give the game a new board for num_players; players keep their colors if the board has them."""
    board, shapes = create_board_state(num_players)
    game.update(
        numPlayers=num_players,
        teams=TEAMS[:num_players],
        layout={"cells": shapes},  # Static during play, so the per-second updates leave it out.
        board=board,
    )
    for player in game["players"].values():
        if player["team"] not in game["teams"]:
            player["team"] = None
    old_bots = game.get("bots", {})
    game["bots"] = {team: old_bots.get(team, DEFAULT_BOT) for team in game["teams"]}

def create_game(num_players):
    # A game starts in the lobby: players join and choose colors, then someone starts it.
    game = {"status": "lobby", "players": {}}
    new_map(game, num_players)
    return game

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
          <li>Choose 2 to 6 players in the lobby. The board is a polygon grid with one base per player in its corners: squares for 2 and 4 players, triangles for 3, a pentagon of quadrilaterals for 5, hexagons for 6.</li>
          <li>Extra (grey) spawns generate troops only after they are conquered.</li>
          <li>Click a cell with troops to select it, then click on a destination cell to move your troops.</li>
          <li>If you conquer a cell, it changes to your team's color.</li>
          <li>If you conquer your enemy's base, then all cells owned by that enemy become yours.</li>
          <li>All players join with the same game code. In the lobby everyone chooses a color, then anyone can start the game.</li>
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

MAX_NAME_LENGTH = 20

def clean_name(name):
    name = str(name or "").strip()[:MAX_NAME_LENGTH].strip()
    return name or "Anonymous"

def broadcast_lobby(game_key):
    """Send the whole game, with the board shapes, to everybody in it; clients in the lobby show it."""
    socketio.emit('lobby_state', dict(games[game_key], botOptions=BOT_OPTIONS), room=game_key)

def lobby_sender(data):
    """Return (game key, game, player) for the sender of an event, or (None, None, None)."""
    game_key = data.get('game_key')
    game = games.get(game_key)
    player = game["players"].get(request.sid) if game else None
    return (game_key, game, player) if player else (None, None, None)

@socketio.on('join_lobby')
def handle_join_lobby(data):
    """Add the sender to the game's lobby; a new game uses the requested player count."""
    game_key = data.get('game_key')
    if not isinstance(game_key, str) or not game_key:
        return
    game = get_or_create_game(game_key, data.get('players', DEFAULT_PLAYERS))
    # A client that reconnects sends its color again.
    team = data.get('team') if data.get('team') in game["teams"] else None
    game["players"][request.sid] = {"name": clean_name(data.get('player_name')), "team": team}
    join_room(game_key)
    broadcast_lobby(game_key)
    print(f"Player {game['players'][request.sid]['name']} joined game {game_key} (sid: {request.sid})")

@socketio.on('set_name')
def handle_set_name(data):
    game_key, game, player = lobby_sender(data)
    if player:
        player["name"] = clean_name(data.get('player_name'))
        broadcast_lobby(game_key)

@socketio.on('choose_team')
def handle_choose_team(data):
    """Set the sender's color; None leaves the color. Also works for players who join a running game."""
    game_key, game, player = lobby_sender(data)
    team = data.get('team')
    if player and (team is None or team in game["teams"]):
        player["team"] = team
        broadcast_lobby(game_key)

@socketio.on('set_bot')
def handle_set_bot(data):
    """Choose the bot that plays a color while the color has no human players."""
    game_key, game, player = lobby_sender(data)
    team, bot = data.get('team'), data.get('bot')
    if player and game["status"] == "lobby" and team in game["teams"] and bot in BOTS:
        game["bots"][team] = bot
        broadcast_lobby(game_key)

@socketio.on('set_player_count')
def handle_set_player_count(data):
    game_key, game, player = lobby_sender(data)
    if player and game["status"] == "lobby":
        new_map(game, clamp_players(data.get('players')))
        broadcast_lobby(game_key)

@socketio.on('regenerate_map')
def handle_regenerate_map(data):
    """New spawn positions for the same player count; the colors stay."""
    game_key, game, player = lobby_sender(data)
    if player and game["status"] == "lobby":
        new_map(game, game["numPlayers"])
        broadcast_lobby(game_key)

@socketio.on('start_game')
def handle_start_game(data):
    game_key, game, player = lobby_sender(data)
    if player and game["status"] == "lobby" and any(p["team"] for p in game["players"].values()):
        game["status"] = "playing"
        broadcast_lobby(game_key)
        print(f"Game {game_key} started")

@socketio.on('disconnect')
def handle_disconnect():
    for game_key, game in list(games.items()):
        if game["players"].pop(request.sid, None) is not None:
            broadcast_lobby(game_key)

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
    if game["status"] != "playing" or game.get('isPaused', False):  # Only moves in a running game
        return

    move = data

    # Retrieve the player's information.
    player = game["players"].get(request.sid)
    if not player:
        print("Player not found for sid:", request.sid)
        return

    # Check if the player's chosen team matches the move's team.
    if player.get("team") != move.get("team"):
        print(f"Move rejected: player's team ({player.get('team')}) does not match move team ({move.get('team')}).")
        return

    launch_move(game_key, game, move)

def launch_move(game_key, game, move):
    """Start a move of a player or a bot: move has from and to (cell ids) and team. A move sends
    all troops of the cell, as counted by the server (the client's count can be a second old)."""
    board = game["board"]
    from_id = move.get('from')
    to_id = move.get('to')
    if not all(isinstance(cell_id, int) and 0 <= cell_id < len(board) for cell_id in (from_id, to_id)):
        print(f"Move rejected: invalid cell ids. From: {from_id} To: {to_id}")
        return
    attacking_team = move["team"]

    from_cell = board[from_id]
    to_cell = board[to_id]

    # Prevent moves from or to white cells (non-spawn cells without an owner)
    if (from_cell["owner"] is None and not from_cell["isSpawn"]) or (to_cell["owner"] is None and not to_cell["isSpawn"]):
        print(f"Move rejected: can't move from/to white cell. From: {from_id} To: {to_id}")
        return
    if from_cell["owner"] != attacking_team:
        print(f"Move rejected: cell {from_id} does not belong to {attacking_team}.")
        return
    attacking_troops = from_cell["troops"]
    if attacking_troops < 1:
        print(f"Move rejected: no troops to send from cell {from_id}.")
        return
    move["troops"] = attacking_troops

    # Remove troops from the source cell immediately.
    from_cell["troops"] = 0
    target_owner = to_cell["owner"]  # At the start: an attack is a move aimed at a cell of that color.

    # Calculate Euclidean distance and duration.
    distance = cell_distance(from_cell, to_cell)
    duration = distance * 1000  # 1 second per cell

    # Generate a unique move ID.
    move_id = str(uuid.uuid4())
    move["id"] = move_id

    # Emit a start_move event with move data, duration, and the source cell with fewer troops.
    socketio.emit('start_move', {"move": move, "duration": duration, "cells": [from_cell]}, room=game_key)
    flights = game_runtime(game_key, game)["flights"]  # Bots see the moves on the way, as players do.
    flights[move_id] = {"from": from_id, "to": to_id, "team": attacking_team, "troops": attacking_troops,
                        "aimed_at": target_owner, "arrives": time.monotonic() + distance}
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
        flights.pop(move_id, None)
        changed = [to_cell]  # Cells to send with end_move; the whole board goes out every second.
        defending_team = to_cell["owner"]
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
                            changed.append(cell)
            elif attacking_troops < defending_troops:
                to_cell["troops"] = defending_troops - attacking_troops
            else:
                to_cell["troops"] = 0
                to_cell["owner"] = None
                to_cell["spawnActive"] = False

        # A bot learns that it was attacked. Troops that set out for a free cell and found it taken
        # meanwhile do not count.
        if defending_team not in (None, attacking_team) and defending_team == target_owner and defending_team not in human_teams(game):
            bot_for(game_key, game, defending_team).attacked(game, defending_team, attacking_team)

        # Emit end_move event with move_id and the changed cells.
        socketio.emit('end_move', {"move_id": move_id, "cells": changed}, room=game_key)
        print(f"Emitted end_move for game {game_key} with move_id {move_id}.")
    eventlet.spawn(process_move)

def generate_troops():
    """Background thread that updates troop counts and sends updates each second."""
    while True:
        for game_key, game in list(games.items()):  # Use list() to avoid RuntimeError from dict changing size during iteration
            if game["status"] == "playing" and not game.get('isPaused', False):  # Only in a running game
                for cell in game["board"]:
                    if cell["isSpawn"] and cell["spawnActive"]:
                        cell["troops"] += 1
                run_bots(game_key, game)
                socketio.emit('game_state', without_layout(game), room=game_key)
                print(f"Updated troops for game {game_key}")
        socketio.sleep(1)

runtime = {}  # Game key -> server-only state of the game: bot objects and moves on the way.

def game_runtime(game_key, game):
    """Server-only state of the game, which clients do not get; a new game with the same key starts afresh."""
    state = runtime.get(game_key)
    if state is None or state["game"] is not game:
        state = runtime[game_key] = {"game": game, "bots": {}, "flights": {}}
    return state

def bot_for(game_key, game, team):
    """The bot object that plays the team in this game; made on first use."""
    bots = game_runtime(game_key, game)["bots"]
    if team not in bots:
        bots[team] = BOTS[game["bots"][team]]()
    return bots[team]

def human_teams(game):
    return {player["team"] for player in game["players"].values()}

def run_bots(game_key, game):
    """Let the bot of every color without human players start its move for this second."""
    humans = human_teams(game)
    flights = list(game_runtime(game_key, game)["flights"].values())
    for team in game["teams"]:
        if team not in humans:
            move = bot_for(game_key, game, team).move(game, team, flights)
            if move:
                launch_move(game_key, game, {"game_key": game_key, "from": move[0], "to": move[1], "team": team})

@socketio.on('finish_game')
def handle_finish_game(data):
    """Handle game finish requests by cleaning up the game state."""
    game_key = data.get('game_key')
    if game_key not in games:
        return

    # Delete the game state
    del games[game_key]
    runtime.pop(game_key, None)
    print(f"Game {game_key} finished and cleaned up")
    
    # Notify all clients in the room that the game is finished
    socketio.emit('game_finished', room=game_key)

if __name__ == '__main__':
    troop_thread = threading.Thread(target=generate_troops)
    troop_thread.daemon = True
    troop_thread.start()
    socketio.run(app, host='0.0.0.0', port=5001, debug=True)
