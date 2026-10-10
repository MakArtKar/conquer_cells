// Board layout. The server gives the cell shapes in cells (neighbor distance 1, center at 0,0);
// renderBoard picks the pixel size of one cell so the board fits the window.
const MAX_BOARD_WIDTH = 1100;   // Board width limit in pixels.
const RESERVED_HEIGHT = 150;    // Window height used by the controls and margins, in pixels.
const BOARD_PADDING = 8;        // Room around the cells for thick outlines and the enlarged selected cell, in pixels.
const MIN_CELL_SPACING = 24;    // Pixel distance between neighboring cells, lower limit.
const MAX_CELL_SPACING = 64;    // Pixel distance between neighboring cells, upper limit.
const SVG_NS = 'http://www.w3.org/2000/svg';

const MIN_PLAYERS = 2;
const MAX_PLAYERS = 6;
const DEFAULT_PLAYERS = 4;

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
let boardLayout = null;  // Pixel scale and offset of the rendered board
let boardState = null;
let selectedCell = null;
let gameState = null;  // Store complete game state
let currentPlayer = null;  // Store current player info
let isPaused = false;  // Track pause state
let pauseStartTime = null;  // Track when pause started
let totalPauseDuration = 0;  // Track cumulative pause duration

document.addEventListener('DOMContentLoaded', () => {
  const appDiv = document.getElementById("app");
  const path = window.location.pathname; // e.g., "/" or "/apple"

  if (path === "/" || path === "") {
    renderWelcomePage(appDiv);
    return;
  }

  const gameKey = path.substring(1); // Remove the leading "/"
  const requestedPlayers = new URLSearchParams(window.location.search).get('players');
  renderGamePage(appDiv);
  initializeGame(gameKey, requestedPlayers);
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

function renderWelcomePage(appDiv) {
  const welcomeHTML = `
    <div class="welcome-container">
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
      <p>Number of players:</p>
      <div id="player-count" class="player-count"></div>
      <p>Choose a game below (refresh for new keys):</p>
      <ul id="game-links"></ul>
    </div>
  `;
  appDiv.innerHTML = welcomeHTML;
  const gameLinksUl = document.getElementById("game-links");
  const keys = generateRandomKeys(5);
  const gameLinks = keys.map(key => {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.dataset.key = key;
    a.textContent = key.charAt(0).toUpperCase() + key.slice(1);
    li.appendChild(a);
    gameLinksUl.appendChild(li);
    return a;
  });

  // The selected player count goes into the game links; the first player to join creates the game.
  const playerCountDiv = document.getElementById("player-count");
  const selectPlayerCount = (count) => {
    playerCountDiv.querySelectorAll('button').forEach(button => {
      button.classList.toggle('selected', Number(button.dataset.count) === count);
    });
    gameLinks.forEach(a => { a.href = `/${a.dataset.key}?players=${count}`; });
  };
  for (let count = MIN_PLAYERS; count <= MAX_PLAYERS; count++) {
    const button = document.createElement("button");
    button.dataset.count = count;
    button.textContent = count;
    button.addEventListener('click', () => selectPlayerCount(count));
    playerCountDiv.appendChild(button);
  }
  selectPlayerCount(DEFAULT_PLAYERS);
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

function initializeGame(gameKey, requestedPlayers) {
  const socket = io();
  let updateLeaderboardInterval;  // Store interval ID for cleanup
  let animationFrameId;  // Store animation frame ID for cleanup

  let gameInfo = null;  // Player count and teams of this game, from the server

  // Create modal dialog for player input; the teams are filled in when the game info arrives.
  const modalHtml = `
    <div id="player-input-modal" style="
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      background: white;
      padding: 20px;
      border-radius: 10px;
      box-shadow: 0 4px 6px rgba(0,0,0,0.1);
      z-index: 1000;
    ">
      <h2 style="margin-top: 0;">Join Game</h2>
      <p id="game-player-count" style="margin-top: 0; color: #555;"></p>
      <div style="margin-bottom: 15px;">
        <label>Your Name:</label>
        <input type="text" id="player-name" style="
          width: 100%;
          padding: 5px;
          margin-top: 5px;
          border: 1px solid #ccc;
          border-radius: 4px;
        ">
      </div>
      <div style="margin-bottom: 15px;">
        <label>Select Team:</label>
        <div id="team-options" style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; margin-top: 5px;"></div>
      </div>
      <button id="join-game-btn" disabled style="
        width: 100%;
        padding: 10px;
        background: #4CAF50;
        color: white;
        border: none;
        border-radius: 4px;
        cursor: pointer;
      ">Join Game</button>
    </div>
    <div style="
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0,0,0,0.5);
      z-index: 999;
    "></div>
  `;

  // Add modal to page
  const modalContainer = document.createElement('div');
  modalContainer.innerHTML = modalHtml;
  document.body.appendChild(modalContainer);

  // Ask the server for the game's player count: an existing game keeps its own count.
  socket.emit('game_info', { game_key: gameKey, players: requestedPlayers }, (info) => {
    gameInfo = info;
    // Keep the actual player count in the URL, so a shared link creates the same game again.
    window.history.replaceState(null, '', `/${gameKey}?players=${info.numPlayers}`);
    document.getElementById('game-player-count').textContent = `${info.numPlayers}-player game`;
    document.getElementById('team-options').innerHTML = info.teams.map((team, i) => `
      <label style="display: flex; align-items: center; gap: 5px;">
        <input type="radio" name="team" value="${team}"${i === 0 ? ' required' : ''}>
        <span style="color: ${TEAM_STYLES[team].fill};">${TEAM_STYLES[team].label} Team</span>
      </label>
    `).join('');
    document.getElementById('join-game-btn').disabled = false;
  });

  // Set up all socket event handlers first
  socket.on('pause_state', (data) => {
    const wasPaused = isPaused;
    isPaused = data.isPaused;
    const pauseButton = document.getElementById('pause-button');
    pauseButton.textContent = isPaused ? "▶️ Resume Game" : "⏸️ Pause Game";
    pauseButton.classList.toggle('paused', isPaused);
    
    if (isPaused) {
      pauseStartTime = performance.now();
    } else if (wasPaused && pauseStartTime) {
      totalPauseDuration += performance.now() - pauseStartTime;
      pauseStartTime = null;
    }
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
    if (state) {
      gameState = state;
      if (state.board) {
        boardState = state.board;
        if (boardCells.length === 0) {
          if (!state.layout) return;  // Only the reply to join_game has the cell shapes
          renderBoard(state);
        }
        updateBoard(boardState);
        updateLeaderboard();
      }
    }
  });

  // Handle form submission
  const joinButton = document.getElementById('join-game-btn');
  joinButton.addEventListener('click', () => {
    const nameInput = document.getElementById('player-name');
    const teamInput = document.querySelector('input[name="team"]:checked');
    
    const validatedName = nameInput.value.trim() || 'Anonymous';
    const validatedTeam = teamInput ? teamInput.value : 'neutral';

    // Remove modal
    modalContainer.remove();

    // Store current player info
    currentPlayer = { name: validatedName, team: validatedTeam };
    
    // Connect to game
    socket.emit('join_game', { 
      game_key: gameKey, 
      player_name: validatedName, 
      team: validatedTeam,
      players: gameInfo.numPlayers
    });

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

    // Start periodic leaderboard updates and store interval ID
    updateLeaderboardInterval = setInterval(updateLeaderboard, 1000);
  });

  // Lay out the board: the cell shapes come from the server, the pixel scale fits the window.
  function renderBoard(state) {
    const board = state.board;
    const shapes = state.layout.cells;  // Corner points of each cell, indexed by cell id
    const container = document.getElementById('board-container');
    const boardElem = document.getElementById('game-board');

    const corners = shapes.flat();
    const minX = Math.min(...corners.map(p => p[0]));
    const minY = Math.min(...corners.map(p => p[1]));
    const width = Math.max(...corners.map(p => p[0])) - minX;
    const height = Math.max(...corners.map(p => p[1])) - minY;
    const availableWidth = Math.min(window.innerWidth - 40, MAX_BOARD_WIDTH);
    const availableHeight = window.innerHeight - RESERVED_HEIGHT;
    const fit = Math.min((availableWidth - 2 * BOARD_PADDING) / width, (availableHeight - 2 * BOARD_PADDING) / height);
    const spacing = Math.max(MIN_CELL_SPACING, Math.min(MAX_CELL_SPACING, fit));
    boardLayout = { spacing, minX, minY };

    // The dark board shape behind the cells shows through the hovered (half transparent) cell.
    const boardWidth = width * spacing + 2 * BOARD_PADDING;
    const boardHeight = height * spacing + 2 * BOARD_PADDING;
    container.style.width = `${boardWidth}px`;
    container.style.height = `${boardHeight}px`;
    boardElem.innerHTML = `
      <svg class="board-shape" width="${boardWidth}" height="${boardHeight}">
        <path class="board-outline" d="${shapes.map(shape => `M${polygonPoints(shape)}Z`).join('')}"></path>
      </svg>
    `;
    const svg = boardElem.querySelector('svg');

    // One font size for the whole board, so that a 3-digit count fits into the smallest cell.
    const minInradius = Math.min(...board.map(cell => distanceToSides([cell.x, cell.y], shapes[cell.id])));
    const fontSize = Math.max(9, Math.round(minInradius * spacing * 0.75));

    // Spawns and bases go last: in SVG a later cell covers the outer half of an earlier cell's outline.
    const drawOrder = [...board].sort((a, b) => (a.isSpawn + a.isBase) - (b.isSpawn + b.isBase));
    boardCells = [];
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
      cellElem.addEventListener('click', onCellClick);
      svg.appendChild(cellElem);
      boardCells[cellData.id] = cellElem;
    });
    console.log(`Client rendered board at ${new Date().toLocaleTimeString()}.`);
    drawActiveMoveVectors();
    updateLeaderboard();
  }

  // SVG points of a polygon given in board coordinates.
  function polygonPoints(corners) {
    return corners.map(([x, y]) => {
      const p = toPixels(x, y);
      return `${p.x},${p.y}`;
    }).join(' ');
  }

  // Distance from a point to the nearest side of a convex polygon.
  function distanceToSides(point, corners) {
    return Math.min(...corners.map((a, i) => {
      const b = corners[(i + 1) % corners.length];
      const cross = (b[0] - a[0]) * (a[1] - point[1]) - (a[0] - point[0]) * (b[1] - a[1]);
      return Math.abs(cross) / Math.hypot(b[0] - a[0], b[1] - a[1]);
    }));
  }

  function toPixels(x, y) {
    return {
      x: (x - boardLayout.minX) * boardLayout.spacing + BOARD_PADDING,
      y: (y - boardLayout.minY) * boardLayout.spacing + BOARD_PADDING
    };
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
      
      // Can only select cells that belong to player's team and have troops
      if (cellData.owner === currentPlayer.team && cellData.troops > 0) {
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
    return toPixels(cell.x, cell.y);
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
          teamTotals[player.team].players.push(player.name);
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
                <td class="player-names">${stats.players.length > 0 ? stats.players.join(', ') : '-'}</td>
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
