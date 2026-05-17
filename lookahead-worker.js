const PITS = 6;
const LOOKAHEAD_TERMINAL_SCORE_WEIGHT = 100000;
const LOOKAHEAD_STORE_SCORE_WEIGHT = 1000;
const LOOKAHEAD_PIT_SCORE_WEIGHT = 25;
const LOOKAHEAD_EXTRA_TURN_WEIGHT = 40;
const LOOKAHEAD_CAPTURE_WEIGHT = 10;
const LOOKAHEAD_MOBILITY_WEIGHT = 5;
const LOOKAHEAD_MIN_SCORE = -2147483648;
const LOOKAHEAD_MAX_SCORE = 2147483647;

let workerEngineKind = null;
let wasmCpuEngineExports = null;

function clonePitCounts(pits) {
  return [pits[0].slice(), pits[1].slice()];
}

function cloneStoreCounts(stores) {
  return [stores[0], stores[1]];
}

function simulateMove(boardState, playerIdx, pitIdx) {
  if (!Number.isInteger(pitIdx) || pitIdx < 0 || pitIdx >= PITS) return null;

  const pits = clonePitCounts(boardState.pits);
  const stores = cloneStoreCounts(boardState.stores);
  const opponentIdx = 1 - playerIdx;

  let seeds = pits[playerIdx][pitIdx];
  if (seeds === 0) {
    return {
      pits,
      stores,
      currentPlayer: boardState.currentPlayer,
      gameOver: boardState.gameOver,
      sowPath: [],
      capture: null,
      collectedPits: [],
      extraTurn: false,
      scoreDelta: 0,
    };
  }

  pits[playerIdx][pitIdx] = 0;

  let pos = pitIdx;
  let extraTurn = false;
  let lastSide = -1;
  let lastPitIdx = -1;
  const sowPath = [];
  let capture = null;
  const collectedPits = [];

  while (seeds > 0) {
    pos++;
    if (pos > 13) pos = 0;
    if (pos === 13) continue;
    sowPath.push(pos);
    seeds--;

    if (pos >= 0 && pos <= 5) {
      pits[playerIdx][pos]++;
      lastSide = 0;
      lastPitIdx = pos;
    } else if (pos === 6) {
      stores[playerIdx]++;
      lastSide = 1;
      lastPitIdx = -1;
    } else if (pos >= 7 && pos <= 12) {
      const oppPitIdx = pos - 7;
      pits[opponentIdx][oppPitIdx]++;
      lastSide = 2;
      lastPitIdx = oppPitIdx;
    }
  }

  if (lastSide === 1) extraTurn = true;

  if (lastSide === 0 && pits[playerIdx][lastPitIdx] === 1) {
    const oppositeIdx = PITS - 1 - lastPitIdx;
    if (pits[opponentIdx][oppositeIdx] > 0) {
      const captured = pits[playerIdx][lastPitIdx] + pits[opponentIdx][oppositeIdx];
      stores[playerIdx] += captured;
      pits[playerIdx][lastPitIdx] = 0;
      pits[opponentIdx][oppositeIdx] = 0;
      capture = { landingPitIdx: lastPitIdx, oppositePitIdx: oppositeIdx, capturedSeeds: captured };
    }
  }

  let currentPlayer = extraTurn ? playerIdx : opponentIdx;
  let gameOver = false;
  const p0empty = pits[0].every(function(count) { return count === 0; });
  const p1empty = pits[1].every(function(count) { return count === 0; });

  if (p0empty || p1empty) {
    for (let i = 0; i < PITS; i++) {
      if (pits[0][i] > 0) collectedPits.push({ playerIdx: 0, pitIdx: i });
      if (pits[1][i] > 0) collectedPits.push({ playerIdx: 1, pitIdx: i });
      stores[0] += pits[0][i];
      stores[1] += pits[1][i];
      pits[0][i] = 0;
      pits[1][i] = 0;
    }
    gameOver = true;
  }

  return {
    pits,
    stores,
    currentPlayer,
    gameOver,
    sowPath,
    capture,
    collectedPits,
    extraTurn,
    scoreDelta: stores[playerIdx] - boardState.stores[playerIdx],
  };
}

function listLegalPitIndices(boardState, playerIdx) {
  const legalPitIndices = [];
  for (let pitIdx = 0; pitIdx < PITS; pitIdx++) {
    if (boardState.pits[playerIdx][pitIdx] > 0) legalPitIndices.push(pitIdx);
  }
  return legalPitIndices;
}

function scoreLookaheadMovePriority(result, pitIdx) {
  return (result.gameOver ? 10000 : 0)
    + (result.extraTurn ? 5000 : 0)
    + ((result.capture && result.capture.capturedSeeds ? result.capture.capturedSeeds : 0) * 100)
    + (result.scoreDelta * 10)
    + pitIdx;
}

function getOrderedLookaheadPitIndices(boardState) {
  const playerIdx = boardState.currentPlayer;
  return listLegalPitIndices(boardState, playerIdx)
    .map(function(pitIdx) {
      return { pitIdx, result: simulateMove(boardState, playerIdx, pitIdx) };
    })
    .filter(function(entry) { return !!entry.result; })
    .sort(function(left, right) {
      return scoreLookaheadMovePriority(right.result, right.pitIdx) - scoreLookaheadMovePriority(left.result, left.pitIdx);
    })
    .map(function(entry) { return entry.pitIdx; });
}

function sumLookaheadPitCounts(boardState, playerIdx) {
  return boardState.pits[playerIdx].reduce(function(total, count) { return total + count; }, 0);
}

function countLookaheadExtraTurnMoves(boardState, playerIdx) {
  return listLegalPitIndices(boardState, playerIdx)
    .map(function(pitIdx) { return simulateMove(boardState, playerIdx, pitIdx); })
    .filter(function(result) { return result && result.extraTurn && !result.gameOver; })
    .length;
}

function getBestLookaheadCapture(boardState, playerIdx) {
  return listLegalPitIndices(boardState, playerIdx)
    .map(function(pitIdx) { return simulateMove(boardState, playerIdx, pitIdx); })
    .reduce(function(bestCapture, result) {
      if (!result || !result.capture) return bestCapture;
      return Math.max(bestCapture, result.capture.capturedSeeds || 0);
    }, 0);
}

function evaluateLookaheadBoard(boardState, maximizingPlayerIdx, config) {
  const opponentIdx = 1 - maximizingPlayerIdx;
  const storeDiff = boardState.stores[maximizingPlayerIdx] - boardState.stores[opponentIdx];
  if (boardState.gameOver) {
    return storeDiff * config.terminalScoreWeight;
  }

  const pitDiff = sumLookaheadPitCounts(boardState, maximizingPlayerIdx) - sumLookaheadPitCounts(boardState, opponentIdx);
  const mobilityDiff = listLegalPitIndices(boardState, maximizingPlayerIdx).length - listLegalPitIndices(boardState, opponentIdx).length;
  const extraTurnDiff = countLookaheadExtraTurnMoves(boardState, maximizingPlayerIdx) - countLookaheadExtraTurnMoves(boardState, opponentIdx);
  const captureDiff = getBestLookaheadCapture(boardState, maximizingPlayerIdx) - getBestLookaheadCapture(boardState, opponentIdx);

  return (storeDiff * config.storeScoreWeight)
    + (pitDiff * config.pitScoreWeight)
    + (extraTurnDiff * config.extraTurnWeight)
    + (captureDiff * config.captureWeight)
    + (mobilityDiff * config.mobilityWeight);
}

function searchJavaScriptLookahead(boardState, maximizingPlayerIdx, depth, config, alpha, beta, deadlineMs) {
  if (deadlineMs != null && performance.now() >= deadlineMs) {
    return {
      score: evaluateLookaheadBoard(boardState, maximizingPlayerIdx, config),
      bestMove: -1,
      completed: false,
    };
  }

  if (depth === 0 || boardState.gameOver) {
    return {
      score: evaluateLookaheadBoard(boardState, maximizingPlayerIdx, config),
      bestMove: -1,
      completed: true,
    };
  }

  const orderedPitIndices = getOrderedLookaheadPitIndices(boardState);
  if (orderedPitIndices.length === 0) {
    return {
      score: evaluateLookaheadBoard(boardState, maximizingPlayerIdx, config),
      bestMove: -1,
      completed: true,
    };
  }

  const maximizingTurn = boardState.currentPlayer === maximizingPlayerIdx;
  let bestMove = orderedPitIndices[0];
  let bestScore = maximizingTurn ? LOOKAHEAD_MIN_SCORE : LOOKAHEAD_MAX_SCORE;

  for (let idx = 0; idx < orderedPitIndices.length; idx++) {
    const pitIdx = orderedPitIndices[idx];
    const nextBoardState = simulateMove(boardState, boardState.currentPlayer, pitIdx);
    if (!nextBoardState) continue;

    const childResult = searchJavaScriptLookahead(nextBoardState, maximizingPlayerIdx, depth - 1, config, alpha, beta, deadlineMs);
    if (!childResult.completed) {
      return {
        score: childResult.score,
        bestMove,
        completed: false,
      };
    }

    if (maximizingTurn) {
      if (childResult.score > bestScore) {
        bestScore = childResult.score;
        bestMove = pitIdx;
      }
      alpha = Math.max(alpha, bestScore);
    } else {
      if (childResult.score < bestScore) {
        bestScore = childResult.score;
        bestMove = pitIdx;
      }
      beta = Math.min(beta, bestScore);
    }

    if (alpha >= beta) break;
  }

  return {
    score: bestScore,
    bestMove,
    completed: true,
  };
}

function encodeBoardStateForSolver(boardState) {
  return [
    boardState.pits[0][0], boardState.pits[0][1], boardState.pits[0][2],
    boardState.pits[0][3], boardState.pits[0][4], boardState.pits[0][5],
    boardState.pits[1][0], boardState.pits[1][1], boardState.pits[1][2],
    boardState.pits[1][3], boardState.pits[1][4], boardState.pits[1][5],
    boardState.stores[0], boardState.stores[1], boardState.currentPlayer,
  ];
}

function decodePackedScoreResult(packedResult) {
  if (typeof packedResult !== 'bigint') {
    throw new Error('Expected a BigInt packed score result, got ' + typeof packedResult);
  }
  const scoreBits = Number(packedResult & 0xffffffffn);
  const completedDepth = Number((packedResult >> 32n) & 0xffffffffn);
  const score = scoreBits >= 0x80000000 ? scoreBits - 0x100000000 : scoreBits;
  return { score, completedDepth };
}

async function initializeWorker(message) {
  workerEngineKind = message.engineKind;
  if (workerEngineKind === 'rust') {
    const response = await fetch(message.wasmUrl, { cache: 'no-store' });
    if (!response.ok) {
      throw new Error('WASM CPU engine request failed: ' + response.status + ' ' + response.statusText);
    }
    const bytes = await response.arrayBuffer();
    const instance = await WebAssembly.instantiate(bytes, {
      env: {
        now_ms: function() {
          return performance.now();
        },
      },
    });
    const exports = instance.instance.exports;
    if (typeof exports.mancala_solver_search_score_for_time !== 'function'
        || typeof exports.mancala_solver_search_score_window_for_time !== 'function') {
      throw new Error('WASM CPU engine worker export is missing.');
    }
    wasmCpuEngineExports = exports;
  }
}

function runJavaScriptDepthSearch(message) {
  const deadlineMs = performance.now() + message.remainingMs;
  const result = searchJavaScriptLookahead(
    message.boardState,
    message.maximizingPlayerIdx,
    message.depth,
    message.config,
    Number.isInteger(message.alpha) ? message.alpha : LOOKAHEAD_MIN_SCORE,
    Number.isInteger(message.beta) ? message.beta : LOOKAHEAD_MAX_SCORE,
    deadlineMs
  );
  return {
    score: result.score,
    completedDepth: result.completed ? message.depth : 0,
  };
}

function runRustDepthSearch(message) {
  const args = encodeBoardStateForSolver(message.boardState);
  const configArgs = [
    message.config.terminalScoreWeight,
    message.config.storeScoreWeight,
    message.config.pitScoreWeight,
    message.config.extraTurnWeight,
    message.config.captureWeight,
    message.config.mobilityWeight,
  ];
  const alpha = Number.isInteger(message.alpha) ? message.alpha : LOOKAHEAD_MIN_SCORE;
  const beta = Number.isInteger(message.beta) ? message.beta : LOOKAHEAD_MAX_SCORE;
  const packedResult = wasmCpuEngineExports.mancala_solver_search_score_window_for_time.apply(
    null,
    args.concat([message.maximizingPlayerIdx, message.depth, message.remainingMs, alpha, beta]).concat(configArgs)
  );
  return decodePackedScoreResult(packedResult);
}

self.onmessage = async function(event) {
  const message = event.data || {};
  try {
    if (message.type === 'init') {
      await initializeWorker(message);
      self.postMessage({ type: 'ready' });
      return;
    }
    if (message.type === 'search-depth') {
      if (workerEngineKind === 'javascript') {
        const result = runJavaScriptDepthSearch(message);
        self.postMessage({ type: 'search-result', requestId: message.requestId, score: result.score, completedDepth: result.completedDepth });
        return;
      }
      if (workerEngineKind === 'rust') {
        const result = runRustDepthSearch(message);
        self.postMessage({ type: 'search-result', requestId: message.requestId, score: result.score, completedDepth: result.completedDepth });
        return;
      }
      throw new Error('Worker engine is not initialized.');
    }
    throw new Error('Unknown worker message type: ' + message.type);
  } catch (err) {
    self.postMessage({ type: 'error', requestId: message.requestId || null, message: String(err) });
  }
};
