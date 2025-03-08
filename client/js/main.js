// Constant variables for board dimensions
const CELL_SIZE = 80;                   // Cell size in pixels.
const GAP_SIZE = 1;                     // Gap between cells in pixels.
const CELL_TOTAL = CELL_SIZE + GAP_SIZE; // Total space per cell.
const CELL_CENTER_OFFSET = CELL_SIZE / 2;  // Center offset (40px).

// Global variables
let moveAnimations = [];  // Array to store active move animations
let boardCells = [];
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
  renderGamePage(appDiv);
  initializeGame(gameKey);
});

function generateRandomKeys(n) {
  const sampleWords = [
    "apple", "banana", "cherry", "dragon", "eagle",
    "falcon", "grape", "honey", "igloo", "jungle",
    "koala", "lemon", "mango", "nectar", "orange"
  ];
  const keys = [];
  for (let i = 0; i < n; i++) {
    const randomIndex = Math.floor(Math.random() * sampleWords.length);
    keys.push(sampleWords[randomIndex]);
  }
  return keys;
}

function renderWelcomePage(appDiv) {
  const welcomeHTML = `
    <div class="welcome-container">
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
}

function renderGamePage(appDiv) {
  // Wrap the board, overlay, and leaderboard in a container.
  const gameHTML = `
    <div class="game-controls">
      <button id="pause-button">⏸️ Pause Game</button>
    </div>
    <div id="board-container">
      <div id="game-board"></div>
      <canvas id="overlay"></canvas>
    </div>
    <div id="leaderboard"></div>
  `;
  appDiv.innerHTML = gameHTML;
}

function initializeGame(gameKey) {
  const socket = io();
  
  // Create modal dialog for player input
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
        <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; margin-top: 5px;">
          <label style="display: flex; align-items: center; gap: 5px;">
            <input type="radio" name="team" value="red" required>
            <span style="color: #ffaaaa;">Red Team</span>
          </label>
          <label style="display: flex; align-items: center; gap: 5px;">
            <input type="radio" name="team" value="blue">
            <span style="color: #aaaaff;">Blue Team</span>
          </label>
          <label style="display: flex; align-items: center; gap: 5px;">
            <input type="radio" name="team" value="green">
            <span style="color: #aaffaa;">Green Team</span>
          </label>
          <label style="display: flex; align-items: center; gap: 5px;">
            <input type="radio" name="team" value="yellow">
            <span style="color: #ffffaa;">Yellow Team</span>
          </label>
        </div>
      </div>
      <button id="join-game-btn" style="
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

  socket.on('start_move', (data) => {
    if (data && data.move && data.duration) {
      addMoveAnimation(data.move, data.duration);
      updateLeaderboard();
    }
  });

  socket.on('end_move', (data) => {
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
          renderBoard(boardState);
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
      team: validatedTeam 
    });

    // Add pause button handler
    const pauseButton = document.getElementById('pause-button');
    pauseButton.addEventListener('click', () => {
      socket.emit('toggle_pause', { game_key: gameKey });
    });

    // Start periodic leaderboard updates
    setInterval(updateLeaderboard, 1000);
  });

  function renderBoard(board) {
    const boardElem = document.getElementById('game-board');
    boardElem.innerHTML = "";
    boardCells = [];
    for (let r = 0; r < board.length; r++) {
      let rowCells = [];
      for (let c = 0; c < board[r].length; c++) {
        const cellData = board[r][c];
        const cellDiv = document.createElement('div');
        cellDiv.className = "cell";
        if (cellData.owner) {
          cellDiv.classList.add(cellData.owner);
        }
        if (cellData.isSpawn) {
          cellDiv.classList.add("spawn");
          if (!cellData.spawnActive && !cellData.owner) {
            cellDiv.classList.add("inactive-spawn");
          }
        }
        cellDiv.innerText = cellData.troops > 0 ? cellData.troops : "";
        cellDiv.dataset.row = r;
        cellDiv.dataset.col = c;
        cellDiv.addEventListener('click', onCellClick);
        boardElem.appendChild(cellDiv);
        rowCells.push(cellDiv);
      }
      boardCells.push(rowCells);
    }
    console.log(`Client "${validatedName}" rendered board at ${new Date().toLocaleTimeString()}.`);
    drawActiveMoveVectors();
    updateLeaderboard();
  }

  function updateBoard(newBoard) {
    for (let r = 0; r < newBoard.length; r++) {
      for (let c = 0; c < newBoard[r].length; c++) {
        const cellData = newBoard[r][c];
        const cellDiv = boardCells[r][c];
        cellDiv.innerText = cellData.troops > 0 ? cellData.troops : "";
        cellDiv.className = "cell";
        if (cellData.owner) {
          cellDiv.classList.add(cellData.owner);
        }
        if (cellData.isSpawn) {
          cellDiv.classList.add("spawn");
          if (!cellData.spawnActive && !cellData.owner) {
            cellDiv.classList.add("inactive-spawn");
          }
        }
      }
    }
    boardState = newBoard;
    drawActiveMoveVectors();
    updateLeaderboard();
  }

  function onCellClick() {
    const r = parseInt(this.dataset.row);
    const c = parseInt(this.dataset.col);
    const cellData = boardState[r][c];

    // If no cell is selected
    if (!selectedCell) {
      // Can only select cells that belong to player's team and have troops
      if (cellData.owner === currentPlayer.team && cellData.troops > 0) {
        selectedCell = { row: r, col: c, element: this };
        this.classList.add("selected");
        console.log(`Selected cell at (${r},${c}) with ${cellData.troops} troops`);
      }
    } 
    // If a cell is already selected
    else {
      // If clicking the same cell, deselect it
      if (selectedCell.row === r && selectedCell.col === c) {
        this.classList.remove("selected");
        selectedCell = null;
        console.log(`Deselected cell at (${r},${c})`);
        return;
      }

      // Only allow moves from owned cells
      const fromCell = boardState[selectedCell.row][selectedCell.col];
      if (fromCell.owner === currentPlayer.team) {
        const moveData = {
          game_key: gameKey,
          from: { row: selectedCell.row, col: selectedCell.col },
          to: { row: r, col: c },
          troops: fromCell.troops,
          team: currentPlayer.team
        };
        socket.emit('move', moveData);
        console.log(`Moving ${fromCell.troops} troops from (${selectedCell.row},${selectedCell.col}) to (${r},${c})`);
      }

      // Clear selection
      selectedCell.element.classList.remove("selected");
      selectedCell = null;
    }
  }

  function computeDuration(moveData) {
    const dx = moveData.to.col - moveData.from.col;
    const dy = moveData.to.row - moveData.from.row;
    const distance = Math.sqrt(dx * dx + dy * dy);
    return distance * 1000; // 1 second per cell.
  }

  // Calculate the cell center in local coordinates relative to the board container.
  function getCellCenter(cellCoords) {
    return {
      x: cellCoords.col * CELL_TOTAL + CELL_CENTER_OFFSET,
      y: cellCoords.row * CELL_TOTAL + CELL_CENTER_OFFSET
    };
  }

  function addMoveAnimation(moveData, duration) {
    const fromCoords = { row: moveData.from.row, col: moveData.from.col };
    const toCoords = { row: moveData.to.row, col: moveData.to.col };
    const anim = {
      id: moveData.id,
      startPos: getCellCenter(fromCoords),
      endPos: getCellCenter(toCoords),
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
        
        // Draw line from start to end
        ctx.beginPath();
        ctx.moveTo(anim.startPos.x, anim.startPos.y);
        ctx.lineTo(anim.endPos.x, anim.endPos.y);
        ctx.strokeStyle = anim.team;
        ctx.lineWidth = 2;
        ctx.stroke();
        
        // Draw moving troops circle
        ctx.beginPath();
        ctx.arc(x, y, 10, 0, Math.PI * 2);
        ctx.fillStyle = anim.team;
        ctx.fill();
        ctx.fillStyle = 'white';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = '12px Arial';
        ctx.fillText(anim.troops.toString(), x, y);
      }
    });
    
    requestAnimationFrame(drawActiveMoveVectors);
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
    const teamTotals = {
      red: { troops: 0, spawns: 0, cells: 0, players: [] },
      blue: { troops: 0, spawns: 0, cells: 0, players: [] },
      green: { troops: 0, spawns: 0, cells: 0, players: [] },
      yellow: { troops: 0, spawns: 0, cells: 0, players: [] }
    };
    
    // Count board state
    for (let r = 0; r < boardState.length; r++) {
      for (let c = 0; c < boardState[r].length; c++) {
        const cell = boardState[r][c];
        if (cell.owner && teamTotals[cell.owner]) {
          teamTotals[cell.owner].troops += cell.troops;
          teamTotals[cell.owner].cells++;
          if (cell.isSpawn && cell.spawnActive) {
            teamTotals[cell.owner].spawns++;
          }
        }
      }
    }
    
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
                <td class="team-name">${team.charAt(0).toUpperCase() + team.slice(1)}</td>
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
