// Board layout. The server gives the cell shapes in cells (neighbor distance 1, center at 0,0);
// drawBoard picks the pixel size of one cell so the board fits the given space.
const MAX_BOARD_WIDTH = 1100;   // Board width limit in pixels.
const RESERVED_HEIGHT = 150;    // Window height used by the controls and margins, in pixels.
const BOARD_PADDING = 8;        // Room around the cells for thick outlines and the enlarged selected cell, in pixels.
const MIN_CELL_SPACING = 24;    // Pixel distance between neighboring cells, lower limit.
const MAX_CELL_SPACING = 64;    // Pixel distance between neighboring cells, upper limit.
const MINI_MAP_WIDTH = 360;     // Size limit of the lobby's map, in pixels.
const MINI_MAP_HEIGHT = 320;
const SVG_NS = 'http://www.w3.org/2000/svg';

const MIN_PLAYERS = 2;
const MAX_PLAYERS = 6;
const MAX_NAME_LENGTH = 20;
const NAME_STORAGE_KEY = 'conquer-cells-name';

// Display settings per team. An N-player game uses the first N teams of the server's list.
const TEAM_STYLES = {
  red:    { label: 'Red',    fill: '#ffaaaa', line: 'red' },
  blue:   { label: 'Blue',   fill: '#aaaaff', line: 'blue' },
  green:  { label: 'Green',  fill: '#aaffaa', line: 'green' },
  yellow: { label: 'Orange', fill: '#ffc935', line: '#ffc935' },
  purple: { label: 'Purple', fill: '#d9b3ff', line: '#9b30ff' },
  cyan:   { label: 'Cyan',   fill: '#a0eeee', line: '#00a0a0' }
};

// Global variables
let moveAnimations = [];  // Array to store active move animations
let boardCells = [];  // Cell elements, indexed by cell id
let boardToPixels = null;  // Converts board coordinates to pixels on the rendered board
let boardState = null;
let selectedCell = null;
let gameState = null;  // Store complete game state
let currentPlayer = null;  // Store current player info
let isPaused = false;  // Track pause state
let pauseStartTime = null;  // Track when pause started
let totalPauseDuration = 0;  // Track cumulative pause duration
let botLabels = {};  // Bot kind -> label, from the server's lobby_state

document.addEventListener('DOMContentLoaded', () => {
  const appDiv = document.getElementById("app");
  const path = window.location.pathname; // e.g., "/" or "/apple"

  if (path === "/" || path === "") {
    renderWelcomePage(appDiv);
    return;
  }

  const gameKey = path.substring(1); // Remove the leading "/"
  const requestedPlayers = new URLSearchParams(window.location.search).get('players');
  initializeGame(appDiv, gameKey, requestedPlayers);
});

function generateRandomKeys(n) {
  const sampleWords = [
    "apple", "banana", "cherry", "dragon", "eagle",
    "falcon", "grape", "honey", "igloo", "jungle",
    "koala", "lemon", "mango", "nectar", "orange"
  ];

  // Shuffle the array
  const shuffled = [...sampleWords].sort(() => Math.random() - 0.5);

  // Take first n elements (or all if n > array length)
  return shuffled.slice(0, Math.min(n, sampleWords.length));
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function renderWelcomePage(appDiv) {
  const welcomeHTML = `
    <div class="welcome-container">
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
      <form id="code-form" class="code-form">
        <input id="game-code" type="text" placeholder="Game code" maxlength="30" autocomplete="off" required>
        <button type="submit">Join</button>
      </form>
      <p>Or choose a game below (refresh for new keys):</p>
      <ul id="game-links"></ul>
    </div>
  `;
  appDiv.innerHTML = welcomeHTML;
  const gameLinksUl = document.getElementById("game-links");
  const keys = generateRandomKeys(5);
  keys.forEach(key => {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = "/" + key;
    a.textContent = key.charAt(0).toUpperCase() + key.slice(1);
    li.appendChild(a);
    gameLinksUl.appendChild(li);
  });

  // A code is a page path: keep letters, digits, and dashes.
  document.getElementById("code-form").addEventListener('submit', (event) => {
    event.preventDefault();
    const code = document.getElementById("game-code").value.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
    if (code) {
      window.location.href = "/" + code;
    }
  });
}

function renderLobbyPage(appDiv, gameKey) {
  appDiv.innerHTML = `
    <div class="lobby">
      <h1>Game <span class="game-code">${escapeHtml(gameKey)}</span></h1>
      <p id="lobby-status" class="lobby-status">Connecting...</p>
      <div class="lobby-columns">
        <div class="lobby-panel">
          <label class="lobby-name">Your name
            <input id="lobby-name" type="text" maxlength="${MAX_NAME_LENGTH}">
          </label>
          <div id="player-count-row">
            <h2>Number of players</h2>
            <div id="player-count" class="player-count"></div>
          </div>
          <h2 id="players-heading">Players</h2>
          <div id="team-slots" class="team-slots"></div>
          <p id="unassigned" class="unassigned"></p>
        </div>
        <div class="lobby-panel">
          <div id="mini-map" class="mini-map"></div>
          <button id="regenerate-button" class="lobby-button">🔄 New map</button>
        </div>
      </div>
      <button id="start-button" class="lobby-button start-button" disabled>▶️ Start game</button>
    </div>
  `;
}

function renderGamePage(appDiv) {
  // Wrap the board, overlay, and leaderboard in a container.
  const gameHTML = `
    <div class="game-controls">
      <button id="pause-button">⏸️ Pause Game</button>
      <button id="finish-button">🏁 Finish Game</button>
    </div>
    <div id="board-container">
      <div id="game-board"></div>
      <canvas id="overlay"></canvas>
    </div>
    <div id="leaderboard"></div>
  `;
  appDiv.innerHTML = gameHTML;
}

// Draw the board into a new SVG element that fits into maxWidth x maxHeight pixels.
// Returns the SVG, its size, the cell elements (indexed by cell id), and the board-to-pixel transform.
function drawBoard(state, maxWidth, maxHeight, minSpacing, maxSpacing) {
  const board = state.board;
  const shapes = state.layout.cells;  // Corner points of each cell, indexed by cell id

  const corners = shapes.flat();
  const minX = Math.min(...corners.map(p => p[0]));
  const minY = Math.min(...corners.map(p => p[1]));
  const width = Math.max(...corners.map(p => p[0])) - minX;
  const height = Math.max(...corners.map(p => p[1])) - minY;
  const fit = Math.min((maxWidth - 2 * BOARD_PADDING) / width, (maxHeight - 2 * BOARD_PADDING) / height);
  const spacing = Math.max(minSpacing, Math.min(maxSpacing, fit));
  const toPixels = (x, y) => ({
    x: (x - minX) * spacing + BOARD_PADDING,
    y: (y - minY) * spacing + BOARD_PADDING
  });
  const polygonPoints = (points) => points.map(([x, y]) => {
    const p = toPixels(x, y);
    return `${p.x},${p.y}`;
  }).join(' ');

  const svgWidth = width * spacing + 2 * BOARD_PADDING;
  const svgHeight = height * spacing + 2 * BOARD_PADDING;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'board-shape');
  svg.setAttribute('width', svgWidth);
  svg.setAttribute('height', svgHeight);
  // The dark board shape behind the cells shows through the hovered (half transparent) cell.
  const outline = document.createElementNS(SVG_NS, 'path');
  outline.setAttribute('class', 'board-outline');
  outline.setAttribute('d', shapes.map(shape => `M${polygonPoints(shape)}Z`).join(''));
  svg.appendChild(outline);

  // One font size for the whole board, so that a 3-digit count fits into the smallest cell.
  const minInradius = Math.min(...board.map(cell => distanceToSides([cell.x, cell.y], shapes[cell.id])));
  const fontSize = Math.max(9, Math.round(minInradius * spacing * 0.75));

  // Spawns and bases go last: in SVG a later cell covers the outer half of an earlier cell's outline.
  const drawOrder = [...board].sort((a, b) => (a.isSpawn + a.isBase) - (b.isSpawn + b.isBase));
  const cells = [];
  drawOrder.forEach(cellData => {
    const center = toPixels(cellData.x, cellData.y);
    const cellElem = document.createElementNS(SVG_NS, 'g');
    const shapeElem = document.createElementNS(SVG_NS, 'polygon');
    shapeElem.setAttribute('points', polygonPoints(shapes[cellData.id]));
    const troopsElem = document.createElementNS(SVG_NS, 'text');
    troopsElem.setAttribute('x', center.x);
    troopsElem.setAttribute('y', center.y);
    troopsElem.setAttribute('font-size', fontSize);
    cellElem.append(shapeElem, troopsElem);
    cellElem.dataset.id = cellData.id;
    applyCellState(cellElem, cellData);
    svg.appendChild(cellElem);
    cells[cellData.id] = cellElem;
  });
  return { svg, width: svgWidth, height: svgHeight, cells, toPixels };
}

// Distance from a point to the nearest side of a convex polygon.
function distanceToSides(point, corners) {
  return Math.min(...corners.map((a, i) => {
    const b = corners[(i + 1) % corners.length];
    const cross = (b[0] - a[0]) * (a[1] - point[1]) - (a[0] - point[0]) * (b[1] - a[1]);
    return Math.abs(cross) / Math.hypot(b[0] - a[0], b[1] - a[1]);
  }));
}

// Set the classes and troop count of a cell element; keeps the selection.
function applyCellState(cellElem, cellData) {
  const isSelected = cellElem.classList.contains('selected');
  cellElem.setAttribute('class', 'cell');  // SVG elements have no writable className
  if (isSelected) {
    cellElem.classList.add('selected');
  }
  if (cellData.owner) {
    cellElem.classList.add(cellData.owner);
  }
  if (cellData.isSpawn) {
    cellElem.classList.add("spawn");
    if (!cellData.spawnActive && !cellData.owner) {
      cellElem.classList.add("inactive-spawn");
    }
  } else if (!cellData.owner) {
    cellElem.classList.add("empty");
  }
  if (cellData.isBase) {
    cellElem.classList.add("base");
  }
  cellElem.lastChild.textContent = cellData.troops > 0 ? cellData.troops : "";
}

function initializeGame(appDiv, gameKey, requestedPlayers) {
  const socket = io();
  let updateLeaderboardInterval;  // Store interval ID for cleanup
  let animationFrameId;  // Store animation frame ID for cleanup

  let view = 'lobby';  // 'lobby' until the player enters the running game, then 'game'
  let lobbyState = null;  // Last game state from the server's lobby_state
  let myTeam = null;  // Sent again when the socket reconnects
  let myName = localStorage.getItem(NAME_STORAGE_KEY) || `Player ${Math.floor(100 + Math.random() * 900)}`;
  localStorage.setItem(NAME_STORAGE_KEY, myName);

  renderLobbyPage(appDiv, gameKey);
  setupLobbyControls();

  // Join on every connect: after a reconnect the server knows the socket under a new id.
  socket.on('connect', () => {
    socket.emit('join_lobby', { game_key: gameKey, player_name: myName, team: myTeam, players: requestedPlayers });
  });

  socket.on('lobby_state', (state) => {
    lobbyState = state;
    botLabels = Object.fromEntries(state.botOptions.map(option => [option.kind, option.label]));
    if (view !== 'lobby') return;
    const me = state.players[socket.id];
    myTeam = me ? me.team : null;
    // Players with a color enter the game when it starts, or when they choose a color in a running game.
    if (state.status === 'playing' && myTeam) {
      enterGame(state);
    } else {
      renderLobby(state);
    }
  });

  socket.on('pause_state', (data) => {
    if (view !== 'game') return;
    applyPauseState(data.isPaused);
  });

  socket.on('game_finished', () => {
    // Clear all intervals and timeouts
    clearInterval(updateLeaderboardInterval);
    cancelAnimationFrame(animationFrameId);

    // Clear game state
    moveAnimations = [];
    boardCells = [];
    boardState = null;
    selectedCell = null;
    gameState = null;
    currentPlayer = null;
    isPaused = false;
    pauseStartTime = null;
    totalPauseDuration = 0;

    // Disconnect socket
    socket.disconnect();

    // Redirect to welcome page
    window.location.href = '/';
  });

  socket.on('start_move', (data) => {
    if (!gameState) return; // Don't process events if game is finished
    if (data && data.move && data.duration) {
      addMoveAnimation(data.move, data.duration);
      updateLeaderboard();
    }
  });

  socket.on('end_move', (data) => {
    if (!gameState) return; // Don't process events if game is finished
    if (data && data.state) {
      gameState = data.state;
      boardState = data.state.board;
      updateBoard(boardState);
    }
    clearOverlay();
    if (data.move_id) {
      removeMoveAnimation(data.move_id);
      updateLeaderboard();
    }
  });

  socket.on('game_state', (state) => {
    if (view !== 'game' || !state || !state.board) return;
    gameState = state;
    boardState = state.board;
    updateBoard(boardState);
    updateLeaderboard();
  });

  function setupLobbyControls() {
    const nameInput = document.getElementById('lobby-name');
    nameInput.value = myName;
    nameInput.addEventListener('change', () => {
      myName = nameInput.value.trim().slice(0, MAX_NAME_LENGTH) || myName;
      nameInput.value = myName;
      localStorage.setItem(NAME_STORAGE_KEY, myName);
      socket.emit('set_name', { game_key: gameKey, player_name: myName });
    });

    const playerCountDiv = document.getElementById('player-count');
    for (let count = MIN_PLAYERS; count <= MAX_PLAYERS; count++) {
      const button = document.createElement('button');
      button.dataset.count = count;
      button.textContent = count;
      button.addEventListener('click', () => socket.emit('set_player_count', { game_key: gameKey, players: count }));
      playerCountDiv.appendChild(button);
    }

    // Clicking your own color again leaves it.
    const teamSlots = document.getElementById('team-slots');
    teamSlots.addEventListener('click', (event) => {
      const slot = event.target.closest('.team-slot');
      if (slot) {
        const team = slot.dataset.team === myTeam ? null : slot.dataset.team;
        socket.emit('choose_team', { game_key: gameKey, team: team });
      }
    });
    teamSlots.addEventListener('change', (event) => {
      if (event.target.classList.contains('bot-select')) {
        socket.emit('set_bot', { game_key: gameKey, team: event.target.dataset.team, bot: event.target.value });
      }
    });

    document.getElementById('regenerate-button').addEventListener('click', () => {
      socket.emit('regenerate_map', { game_key: gameKey });
    });

    // In a running game, players without a color can watch.
    document.getElementById('start-button').addEventListener('click', () => {
      if (lobbyState && lobbyState.status === 'playing') {
        enterGame(lobbyState);
      } else {
        socket.emit('start_game', { game_key: gameKey });
      }
    });
  }

  function renderLobby(state) {
    const playing = state.status === 'playing';
    const players = Object.entries(state.players).map(([sid, player]) => ({ ...player, isMe: sid === socket.id }));
    const nameHtml = (player) => player.isMe ? `<b>${escapeHtml(player.name)} (you)</b>` : escapeHtml(player.name);

    document.getElementById('lobby-status').textContent = playing
      ? 'The game is on: choose a color to join it, or watch.'
      : 'Choose your color. Anyone can change the map or start the game.';

    document.getElementById('player-count-row').hidden = playing;
    document.querySelectorAll('#player-count button').forEach(button => {
      button.classList.toggle('selected', Number(button.dataset.count) === state.numPlayers);
    });

    document.getElementById('players-heading').textContent = `Players (${players.length})`;
    // A color without players is played by its bot; the bot can be changed until the start.
    document.getElementById('team-slots').innerHTML = state.teams.map(team => {
      const members = players.filter(player => player.team === team);
      const botSelect = `
        <select class="bot-select" data-team="${team}" title="Bot for a free color"${playing ? ' disabled' : ''}>
          ${state.botOptions.map(option => `
            <option value="${option.kind}"${option.kind === state.bots[team] ? ' selected' : ''}>🤖 ${escapeHtml(option.label)}</option>
          `).join('')}
        </select>
      `;
      return `
        <div class="team-row ${team}-row${team === myTeam ? ' current-player-team' : ''}">
          <button class="team-slot" data-team="${team}">
            <span class="team-swatch" style="background: ${TEAM_STYLES[team].fill};"></span>
            <span class="team-label">${TEAM_STYLES[team].label}</span>
            <span class="team-members">${members.length > 0 ? members.map(nameHtml).join(', ') : 'free'}</span>
          </button>
          ${members.length > 0 ? '' : botSelect}
        </div>
      `;
    }).join('');
    const unassigned = players.filter(player => !player.team);
    document.getElementById('unassigned').innerHTML = unassigned.length > 0
      ? `No color yet: ${unassigned.map(nameHtml).join(', ')}`
      : '';

    const miniMap = drawBoard(state, MINI_MAP_WIDTH, MINI_MAP_HEIGHT, 0, MAX_CELL_SPACING);
    document.getElementById('mini-map').replaceChildren(miniMap.svg);
    document.getElementById('regenerate-button').hidden = playing;

    const startButton = document.getElementById('start-button');
    if (playing) {
      startButton.textContent = '👀 Watch game';
      startButton.disabled = false;
    } else {
      startButton.textContent = '▶️ Start game';
      startButton.disabled = !players.some(player => player.team);
    }
  }

  function enterGame(state) {
    view = 'game';
    currentPlayer = { name: myName, team: myTeam };
    renderGamePage(appDiv);
    setupGameControls();
    if (state.isPaused) {
      applyPauseState(true);
    }
    gameState = state;
    boardState = state.board;
    renderBoard(state);
    // Start periodic leaderboard updates and store interval ID
    updateLeaderboardInterval = setInterval(updateLeaderboard, 1000);
  }

  // Show the pause state on the pause button and track the paused time for the move animations.
  function applyPauseState(paused) {
    const wasPaused = isPaused;
    isPaused = paused;
    const pauseButton = document.getElementById('pause-button');
    pauseButton.textContent = isPaused ? "▶️ Resume Game" : "⏸️ Pause Game";
    pauseButton.classList.toggle('paused', isPaused);

    if (isPaused) {
      pauseStartTime = performance.now();
    } else if (wasPaused && pauseStartTime) {
      totalPauseDuration += performance.now() - pauseStartTime;
      pauseStartTime = null;
    }
  }

  function setupGameControls() {
    // Add pause button handler
    const pauseButton = document.getElementById('pause-button');
    pauseButton.addEventListener('click', () => {
      socket.emit('toggle_pause', { game_key: gameKey });
    });

    // Add finish button handler
    const finishButton = document.getElementById('finish-button');
    finishButton.addEventListener('click', () => {
      // Disable the button and all game interactions immediately
      finishButton.disabled = true;
      finishButton.textContent = "Finishing...";

      // Disable the pause button too
      const pauseButton = document.getElementById('pause-button');
      pauseButton.disabled = true;

      // Remove click handlers from all cells
      if (boardCells) {
        boardCells.forEach(cell => {
          cell.removeEventListener('click', onCellClick);
          cell.style.cursor = 'default';
        });
      }

      // Notify server to clean up game state and stop game loops
      socket.emit('finish_game', {
        game_key: gameKey,
        player_name: currentPlayer ? currentPlayer.name : 'Anonymous',
        team: currentPlayer ? currentPlayer.team : 'neutral'
      });

      // Set a timeout to force cleanup if server doesn't respond
      setTimeout(() => {
        // If we haven't already cleaned up (redirected), do it now
        if (window.location.pathname !== '/') {
          console.log('Server did not acknowledge game finish, cleaning up anyway');
          clearInterval(updateLeaderboardInterval);
          cancelAnimationFrame(animationFrameId);

          // Clear game state to stop processing updates
          moveAnimations = [];
          boardCells = [];
          boardState = null;
          selectedCell = null;
          gameState = null;
          currentPlayer = null;
          isPaused = false;
          pauseStartTime = null;
          totalPauseDuration = 0;

          socket.disconnect();
          window.location.href = '/';
        }
      }, 3000); // Wait 3 seconds for server response
    });
  }

  // Lay out the board so that it fits the window.
  function renderBoard(state) {
    const container = document.getElementById('board-container');
    const availableWidth = Math.min(window.innerWidth - 40, MAX_BOARD_WIDTH);
    const availableHeight = window.innerHeight - RESERVED_HEIGHT;
    const drawing = drawBoard(state, availableWidth, availableHeight, MIN_CELL_SPACING, MAX_CELL_SPACING);
    boardToPixels = drawing.toPixels;
    container.style.width = `${drawing.width}px`;
    container.style.height = `${drawing.height}px`;
    document.getElementById('game-board').replaceChildren(drawing.svg);
    boardCells = drawing.cells;
    boardCells.forEach(cellElem => cellElem.addEventListener('click', onCellClick));
    console.log(`Client rendered board at ${new Date().toLocaleTimeString()}.`);
    drawActiveMoveVectors();
    updateLeaderboard();
  }

  function updateBoard(newBoard) {
    if (boardCells.length === 0) return;  // Not rendered yet
    newBoard.forEach(cellData => applyCellState(boardCells[cellData.id], cellData));
    boardState = newBoard;
    // No drawActiveMoveVectors() here: renderBoard started its animation loop already,
    // and every extra call would start one more loop.
    updateLeaderboard();
  }

  function onCellClick() {
    const id = parseInt(this.dataset.id);
    const cellData = boardState[id];

    // If no cell is selected
    if (!selectedCell) {
      // Skip white non-spawn cells (cells with no owner that are not spawn cells)
      if (!cellData.owner && !cellData.isSpawn) {
        console.log(`Can't select white cell ${id}`);
        return;
      }

      // Can only select cells that belong to player's team and have troops (spectators have no team)
      if (currentPlayer.team && cellData.owner === currentPlayer.team && cellData.troops > 0) {
        selectedCell = { id: id, element: this };
        this.classList.add("selected");
        this.parentNode.appendChild(this);  // SVG draws in document order: put the enlarged cell on top
        console.log(`Selected cell ${id} with ${cellData.troops} troops`);
      }
    }
    // If a cell is already selected
    else {
      // If clicking the same cell, deselect it
      if (selectedCell.id === id) {
        this.classList.remove("selected");
        selectedCell = null;
        console.log(`Deselected cell ${id}`);
        return;
      }

      // Prevent moving to white non-spawn cells
      if (!cellData.owner && !cellData.isSpawn) {
        console.log(`Can't move to white cell ${id}`);
        return;
      }

      // Only allow moves from owned cells
      const fromCell = boardState[selectedCell.id];
      if (fromCell.owner === currentPlayer.team) {
        const moveData = {
          game_key: gameKey,
          from: selectedCell.id,
          to: id,
          troops: fromCell.troops,
          team: currentPlayer.team
        };
        socket.emit('move', moveData);
        console.log(`Moving ${fromCell.troops} troops from cell ${selectedCell.id} to cell ${id}`);
      }

      // Clear selection
      selectedCell.element.classList.remove("selected");
      selectedCell = null;
    }
  }

  // Calculate the cell center in local coordinates relative to the board container.
  function getCellCenter(cellId) {
    const cell = boardState[cellId];
    return boardToPixels(cell.x, cell.y);
  }

  function addMoveAnimation(moveData, duration) {
    const anim = {
      id: moveData.id,
      startPos: getCellCenter(moveData.from),
      endPos: getCellCenter(moveData.to),
      duration: duration,
      startTime: performance.now() - totalPauseDuration, // Adjust start time by total pause duration
      team: moveData.team,
      troops: moveData.troops
    };
    moveAnimations.push(anim);
    console.log("Added move animation:", anim);
  }

  function removeMoveAnimation(moveId) {
    moveAnimations = moveAnimations.filter(anim => anim.id !== moveId.toString());
    console.log("After removal, moveAnimations:", moveAnimations);
  }

  // Draw active move vectors on the overlay canvas.
  function drawActiveMoveVectors() {
    const overlay = document.getElementById('overlay');
    const container = document.getElementById('board-container');
    overlay.width = container.offsetWidth;
    overlay.height = container.offsetHeight;

    const ctx = overlay.getContext('2d');
    ctx.clearRect(0, 0, overlay.width, overlay.height);

    const currentTime = performance.now();

    moveAnimations.forEach(anim => {
      // Calculate progress considering total pause duration and current pause if any
      let effectivePauseDuration = totalPauseDuration;
      if (isPaused && pauseStartTime) {
        effectivePauseDuration += currentTime - pauseStartTime;
      }

      const adjustedCurrentTime = currentTime - effectivePauseDuration;
      const progress = (adjustedCurrentTime - anim.startTime) / anim.duration;

      if (progress <= 1) {
        // Calculate current position
        const x = anim.startPos.x + (anim.endPos.x - anim.startPos.x) * progress;
        const y = anim.startPos.y + (anim.endPos.y - anim.startPos.y) * progress;

        const teamColor = TEAM_STYLES[anim.team] ? TEAM_STYLES[anim.team].line : anim.team;

        // Draw line from start to end
        ctx.beginPath();
        ctx.moveTo(anim.startPos.x, anim.startPos.y);
        ctx.lineTo(anim.endPos.x, anim.endPos.y);
        ctx.strokeStyle = teamColor;
        ctx.lineWidth = 2;
        ctx.stroke();

        // Draw moving troops circle
        ctx.beginPath();
        ctx.arc(x, y, 10, 0, Math.PI * 2);
        ctx.fillStyle = teamColor;
        ctx.fill();
        ctx.fillStyle = 'white';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = '12px Arial';
        ctx.fillText(anim.troops.toString(), x, y);
      }
    });

    // Store the animation frame ID
    animationFrameId = requestAnimationFrame(drawActiveMoveVectors);
  }

  function updateOverlay() {
    drawActiveMoveVectors();
  }

  function clearOverlay() {
    const overlay = document.getElementById('overlay');
    const ctx = overlay.getContext('2d');
    ctx.clearRect(0, 0, overlay.width, overlay.height);
  }

  // The bot that plays a color without human players.
  function botName(team) {
    const kind = gameState.bots && gameState.bots[team];
    return kind ? `🤖 ${escapeHtml(botLabels[kind] || kind)}` : '-';
  }

  // Update the leaderboard: show total troops per team and list players.
  function updateLeaderboard() {
    if (!gameState) return;  // Don't update if we don't have game state

    const leaderboard = document.getElementById('leaderboard');
    const teamTotals = {};
    gameState.teams.forEach(team => {
      teamTotals[team] = { troops: 0, spawns: 0, cells: 0, players: [] };
    });

    // Count board state
    boardState.forEach(cell => {
      if (cell.owner && teamTotals[cell.owner]) {
        teamTotals[cell.owner].troops += cell.troops;
        teamTotals[cell.owner].cells++;
        if (cell.isSpawn && cell.spawnActive) {
          teamTotals[cell.owner].spawns++;
        }
      }
    });

    // Add troops from active moves
    moveAnimations.forEach(anim => {
      if (teamTotals[anim.team]) {
        teamTotals[anim.team].troops += anim.troops;
      }
    });

    // Add players to their teams
    if (gameState.players) {
      Object.values(gameState.players).forEach(player => {
        if (teamTotals[player.team]) {
          teamTotals[player.team].players.push(escapeHtml(player.name));
        }
      });
    }

    // Create leaderboard HTML
    const html = `
      <table>
        <tr>
          <td class="team-name">Team</td>
          <td class="player-names">Players</td>
          <td class="stat-value">Troops</td>
          <td class="stat-value">Spawns</td>
          <td class="stat-value">Cells</td>
        </tr>
        ${Object.entries(teamTotals)
          .sort(([,a], [,b]) => b.troops - a.troops)
          .map(([team, stats]) => {
            const isCurrentTeam = team === currentPlayer.team;
            return `
              <tr class="${team}-row${isCurrentTeam ? ' current-player-team' : ''}">
                <td class="team-name">${TEAM_STYLES[team].label}</td>
                <td class="player-names">${stats.players.length > 0 ? stats.players.join(', ') : botName(team)}</td>
                <td class="stat-value">${stats.troops}</td>
                <td class="stat-value">${stats.spawns}</td>
                <td class="stat-value">${stats.cells}</td>
              </tr>
            `;
          }).join('')}
      </table>
    `;

    leaderboard.innerHTML = html;
  }
}
