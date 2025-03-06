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
        <li>If you conquer a cell, it changes to your team’s color.</li>
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
    <div id="board-container">
      <div id="game-board"></div>
      <canvas id="overlay"></canvas>
    </div>
    <div id="leaderboard"></div>
  `;
  appDiv.innerHTML = gameHTML;
}

function initializeGame(gameKey) {
  const socket = io("http://localhost:5001");
  const playerName = prompt("Enter your player name:") || "Anonymous";
  const team = prompt("Enter your team (choose from red, blue, green, yellow):") || "neutral";

  socket.emit('join_game', { game_key: gameKey, player_name: playerName, team: team });
  console.log(`Client "${playerName}" (team: ${team}) joining game "${gameKey}".`);

  socket.on('start_move', (data) => {
    console.log(`Client "${playerName}" received start_move:`, data);
    if (data && data.move && data.duration) {
      addMoveAnimation(data.move, data.duration);
      updateLeaderboard(); // Recompute totals including moving troops.
    }
  });

  socket.on('end_move', (data) => {
    console.log(`Client "${playerName}" received end_move:`, data);
    if (data && data.state && data.state.board) {
      boardState = data.state.board;
      updateBoard(boardState);
    }
    clearOverlay();
    if (data.move_id) {
      console.log(`Removing move animation with ID: ${data.move_id}`);
      removeMoveAnimation(data.move_id);
      console.log("Remaining move animations:", moveAnimations);
      updateLeaderboard();
    }
  });

  socket.on('game_state', (state) => {
    console.log(`Client "${playerName}" received game_state:`, state);
    if (state && state.board) {
      boardState = state.board;
      if (boardCells.length === 0) {
        renderBoard(boardState);
      }
      updateBoard(boardState);
    }
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
    console.log(`Client "${playerName}" rendered board at ${new Date().toLocaleTimeString()}.`);
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

    if (!selectedCell) {
      if (cellData.troops > 0) {
        selectedCell = { row: r, col: c, element: this };
        this.classList.add("selected");
        console.log(`Client "${playerName}" selected cell at (${r},${c}).`);
      }
    } else {
      if (selectedCell.row === r && selectedCell.col === c) {
        this.classList.remove("selected");
        selectedCell = null;
        console.log(`Client "${playerName}" deselected cell at (${r},${c}).`);
        return;
      }
      const moveData = {
        game_key: gameKey,
        from: { row: selectedCell.row, col: selectedCell.col },
        to: { row: r, col: c },
        troops: boardState[selectedCell.row][selectedCell.col].troops,
        team: boardState[selectedCell.row][selectedCell.col].owner || "neutral"
      };
      socket.emit('move', moveData);
      console.log(`Client "${playerName}" sent move:`, moveData);
      boardCells[selectedCell.row][selectedCell.col].classList.remove("selected");
      // Do not add local animation; rely on server's start_move event.
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
      startTime: performance.now(),
      team: moveData.team,  // Save team to draw vector in that color.
      troops: moveData.troops // Save troop count for leaderboard.
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
    moveAnimations.forEach(anim => {
      ctx.beginPath();
      ctx.moveTo(anim.startPos.x, anim.startPos.y);
      ctx.lineTo(anim.endPos.x, anim.endPos.y);
      ctx.strokeStyle = anim.team || "#000"; // Use team color.
      ctx.lineWidth = 2;
      ctx.stroke();
    });
  }

  // Global overlay update loop.
  function updateOverlay() {
    drawActiveMoveVectors();
    requestAnimationFrame(updateOverlay);
  }
  requestAnimationFrame(updateOverlay);

  function clearOverlay() {
    const overlay = document.getElementById('overlay');
    const ctx = overlay.getContext('2d');
    ctx.clearRect(0, 0, overlay.width, overlay.height);
  }

  // Update the leaderboard: show total troops per team and list players.
  function updateLeaderboard() {
    const totals = {};
    // Sum troops for each team from board cells.
    for (let r = 0; r < boardState.length; r++) {
      for (let c = 0; c < boardState[r].length; c++) {
        const cell = boardState[r][c];
        if (cell.owner) {
          totals[cell.owner] = (totals[cell.owner] || 0) + cell.troops;
        }
      }
    }
    // Include troops in active moves.
    moveAnimations.forEach(anim => {
      if (anim.team) {
        totals[anim.team] = (totals[anim.team] || 0) + anim.troops;
      }
    });
    let html = '<h2>Troops per Team</h2><table><tr><th>Team</th><th>Total Troops</th></tr>';
    for (let team in totals) {
      html += `<tr><td>${team}</td><td>${totals[team]}</td></tr>`;
    }
    html += '</table>';

    // Also display player list if available.
    if (boardState.players) {
      html += '<h2>Players</h2><table><tr><th>Player Name</th><th>Team</th></tr>';
      for (let sid in boardState.players) {
        const p = boardState.players[sid];
        html += `<tr><td>${p.name}</td><td>${p.team}</td></tr>`;
      }
      html += '</table>';
    }
    const leaderboardDiv = document.getElementById("leaderboard");
    if (leaderboardDiv) {
      leaderboardDiv.innerHTML = html;
    }
  }

  // Refresh leaderboard periodically.
  setInterval(updateLeaderboard, 1000);
}
