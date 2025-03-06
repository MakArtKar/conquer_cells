document.addEventListener('DOMContentLoaded', () => {
  console.log("Game initialization started.");
  
  // --- Configuration ---
  const boardSize = 16;
  const cellSize = 80;
  const gap = 1;
  const teams = {
    red: { color: '#ff0000', light: '#ffaaaa', dark: 'darkred' },
    blue: { color: '#0000ff', light: '#aaaaff', dark: 'darkblue' },
    green: { color: '#00aa00', light: '#aaffaa', dark: 'darkgreen' },
    yellow: { color: '#ffff00', light: '#ffffaa', dark: 'goldenrod' }
  };

  // --- DOM Elements ---
  const boardElem = document.getElementById('game-board');
  const overlay = document.getElementById('overlay');
  overlay.width = boardElem.clientWidth;
  overlay.height = boardElem.clientHeight;
  const ctx = overlay.getContext('2d');

  // --- Global Variables ---
  let board = [];
  let selectedCell = null;
  let movingTroops = []; // Active moving groups

  // --- Create the Board ---
  for (let r = 0; r < boardSize; r++) {
    board[r] = [];
    for (let c = 0; c < boardSize; c++) {
      let cell = {
        row: r,
        col: c,
        owner: null,       // null means neutral
        troops: 0,
        isSpawn: false,
        spawnActive: false,
        isCorner: false,
        element: document.createElement('div')
      };
      cell.element.classList.add('cell');
      cell.element.dataset.row = r;
      cell.element.dataset.col = c;
      cell.element.addEventListener('click', onCellClick);
      board[r][c] = cell;
      boardElem.appendChild(cell.element);
      updateCellDisplay(cell);
    }
  }
  console.log("Board created with " + boardSize * boardSize + " cells.");

  // --- Setup Corner Spawns ---
  const cornerPositions = [
    { r: 0, c: 0, team: 'red' },
    { r: 0, c: boardSize - 1, team: 'blue' },
    { r: boardSize - 1, c: 0, team: 'green' },
    { r: boardSize - 1, c: boardSize - 1, team: 'yellow' }
  ];
  cornerPositions.forEach(pos => {
    let cell = board[pos.r][pos.c];
    cell.owner = pos.team;
    cell.troops = 0; // Troops start at 0; spawns generate over time.
    cell.isSpawn = true;
    cell.spawnActive = true;
    cell.isCorner = true;
    cell.element.classList.add('spawn', pos.team);
    updateCellDisplay(cell);
  });
  console.log("Corner spawns set.");

  // --- Mark Extra Spawns ---
  let nonCornerCells = [];
  for (let r = 0; r < boardSize; r++) {
    for (let c = 0; c < boardSize; c++) {
      if (!((r === 0 && c === 0) ||
            (r === 0 && c === boardSize - 1) ||
            (r === boardSize - 1 && c === 0) ||
            (r === boardSize - 1 && c === boardSize - 1))) {
        nonCornerCells.push(board[r][c]);
      }
    }
  }
  let spawnCount = Math.floor(nonCornerCells.length * 0.15);
  shuffleArray(nonCornerCells);
  for (let i = 0; i < spawnCount; i++) {
    let cell = nonCornerCells[i];
    cell.isSpawn = true;
    cell.spawnActive = false; // Inactive until conquered.
    cell.element.classList.add('spawn', 'inactive-spawn');
    updateCellDisplay(cell);
  }
  console.log("Extra spawns marked.");

  // --- Utility Functions ---
  function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
      let j = Math.floor(Math.random() * (i + 1));
      [array[i], array[j]] = [array[j], array[i]];
    }
  }

  function updateCellDisplay(cell) {
    let bgColor = '#eee'; // default neutral
    if (cell.isSpawn && !cell.isCorner && !cell.owner) {
      bgColor = '#555';
    } else if (cell.owner) {
      if (cell.isSpawn && !cell.spawnActive) {
        bgColor = '#555';
      } else if (cell.isSpawn && cell.spawnActive) {
        bgColor = teams[cell.owner].dark;
      } else {
        bgColor = teams[cell.owner].light;
      }
    }
    cell.element.style.backgroundColor = bgColor;
    cell.element.textContent = cell.troops > 0 ? cell.troops : '';
  }

  // --- User Interaction ---
  function onCellClick() {
    let r = parseInt(this.dataset.row);
    let c = parseInt(this.dataset.col);
    let cell = board[r][c];
    
    // First click: select cell if it has troops
    if (!selectedCell) {
      if (cell.troops > 0) {
        selectedCell = cell;
        cell.element.classList.add('selected');
      }
    } else {
      // Second click: if target differs, move troops
      if (selectedCell === cell) {
        selectedCell.element.classList.remove('selected');
        selectedCell = null;
        return;
      }
      initiateMovement(selectedCell, cell);
      selectedCell.element.classList.remove('selected');
      selectedCell = null;
    }
  }

  // --- Movement and Animation ---
  function initiateMovement(fromCell, toCell) {
    if (fromCell.troops <= 0) return;
    let group = {
      fromCell: fromCell,
      toCell: toCell,
      team: fromCell.owner,
      troops: fromCell.troops,
      startPos: getCellCenter(fromCell),
      endPos: getCellCenter(toCell),
      startTime: performance.now(),
      duration: getDuration(fromCell, toCell)
    };
    fromCell.troops = 0;
    updateCellDisplay(fromCell);
    movingTroops.push(group);
  }

  function getDuration(fromCell, toCell) {
    let dx = toCell.col - fromCell.col;
    let dy = toCell.row - fromCell.row;
    let distance = Math.sqrt(dx * dx + dy * dy);
    return distance * 1000; // speed: 1 cell per second
  }

  // Calculate the board’s position in the browser
  const boardRect = boardElem.getBoundingClientRect();

  // Update your getCellCenter function to add boardRect offsets
  function getCellCenter(cell) {
    return {
      x: boardRect.left + (cell.col * (cellSize + gap)) + cellSize / 2,
      y: boardRect.top + (cell.row * (cellSize + gap)) + cellSize / 2
    };
  }

  function animate() {
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    let now = performance.now();
    for (let i = movingTroops.length - 1; i >= 0; i--) {
      let group = movingTroops[i];
      let elapsed = now - group.startTime;
      let progress = Math.min(elapsed / group.duration, 1);
      let currentX = group.startPos.x + (group.endPos.x - group.startPos.x) * progress;
      let currentY = group.startPos.y + (group.endPos.y - group.startPos.y) * progress;
      
      // Draw movement vector
      ctx.beginPath();
      ctx.moveTo(group.startPos.x, group.startPos.y);
      ctx.lineTo(group.endPos.x, group.endPos.y);
      ctx.strokeStyle = teams[group.team].color;
      ctx.lineWidth = 2;
      ctx.stroke();
      
      // Draw moving troop as a circle with the troop count
      ctx.beginPath();
      ctx.arc(currentX, currentY, 12, 0, 2 * Math.PI);
      ctx.fillStyle = teams[group.team].color;
      ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.font = "12px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(group.troops, currentX, currentY);
      
      if (progress === 1) {
        resolveArrival(group.toCell, group.team, group.troops);
        movingTroops.splice(i, 1);
      }
    }
    requestAnimationFrame(animate);
  }
  requestAnimationFrame(animate);

  // --- Arrival and Battle Resolution ---
  function resolveArrival(cell, attackingTeam, attackingTroops) {
    if (!cell.owner) {
      cell.owner = attackingTeam;
      cell.troops = attackingTroops;
      if (cell.isSpawn && !cell.spawnActive) {
        cell.spawnActive = true;
      }
    } else if (cell.owner === attackingTeam) {
      cell.troops += attackingTroops;
    } else {
      // Battle: subtract smaller number and update ownership if necessary
      if (attackingTroops > cell.troops) {
        cell.troops = attackingTroops - cell.troops;
        cell.owner = attackingTeam;
        if (cell.isSpawn && !cell.spawnActive) {
          cell.spawnActive = true;
        }
        if (cell.isCorner) {
          convertCells(cell.owner, attackingTeam);
        }
      } else if (attackingTroops < cell.troops) {
        cell.troops -= attackingTroops;
      } else {
        cell.troops = 0;
        cell.owner = null;
      }
    }
    updateCellDisplay(cell);
  }

  function convertCells(fromTeam, toTeam) {
    for (let r = 0; r < boardSize; r++) {
      for (let c = 0; c < boardSize; c++) {
        let cell = board[r][c];
        if (cell.owner === fromTeam) {
          cell.owner = toTeam;
          updateCellDisplay(cell);
        }
      }
    }
  }

  // --- Troop Generation ---
  setInterval(() => {
    for (let r = 0; r < boardSize; r++) {
      for (let c = 0; c < boardSize; c++) {
        let cell = board[r][c];
        if (cell.isSpawn && cell.spawnActive) {
          cell.troops++;
          updateCellDisplay(cell);
        }
      }
    }
  }, 1000);
});
