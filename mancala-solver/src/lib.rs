const PITS: usize = 6;
const TERMINAL_SCORE_WEIGHT: i32 = 100_000;
const STORE_SCORE_WEIGHT: i32 = 1_000;
const PIT_SCORE_WEIGHT: i32 = 25;
const EXTRA_TURN_WEIGHT: i32 = 40;
const CAPTURE_WEIGHT: i32 = 10;
const MOBILITY_WEIGHT: i32 = 5;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Board {
    pits: [[u8; PITS]; 2],
    stores: [u8; 2],
    current_player: usize,
    game_over: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct MoveResult {
    board: Board,
    extra_turn: bool,
    capture_seeds: u8,
    immediate_score: i32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct SearchResult {
    score: i32,
    best_move: i32,
    completed: bool,
}

#[cfg(target_arch = "wasm32")]
unsafe extern "C" {
    fn now_ms() -> f64;
}

#[cfg(target_arch = "wasm32")]
fn current_time_ms() -> f64 {
    unsafe { now_ms() }
}

#[cfg(not(target_arch = "wasm32"))]
fn current_time_ms() -> f64 {
    0.0
}

fn build_board(flat: [u8; 15]) -> Board {
    Board {
        pits: [
            [flat[0], flat[1], flat[2], flat[3], flat[4], flat[5]],
            [flat[6], flat[7], flat[8], flat[9], flat[10], flat[11]],
        ],
        stores: [flat[12], flat[13]],
        current_player: usize::from(flat[14].min(1)),
        game_over: false,
    }
}

fn legal_moves(board: &Board, player: usize) -> Vec<usize> {
    let mut moves = Vec::with_capacity(PITS);
    for pit in 0..PITS {
        if board.pits[player][pit] > 0 {
            moves.push(pit);
        }
    }
    moves
}

fn simulate_move(board: &Board, player: usize, pit_idx: usize) -> Option<MoveResult> {
    if pit_idx >= PITS {
        return None;
    }
    let seeds = board.pits[player][pit_idx];
    if seeds == 0 {
        return None;
    }

    let opponent = 1 - player;
    let mut pits = board.pits;
    let mut stores = board.stores;
    let mut seeds_left = seeds;
    pits[player][pit_idx] = 0;

    let mut pos = pit_idx as i32;
    let mut last_side = -1;
    let mut last_pit = 0usize;

    while seeds_left > 0 {
        pos += 1;
        if pos > 13 {
            pos = 0;
        }
        if pos == 13 {
            continue;
        }
        seeds_left -= 1;

        match pos {
            0..=5 => {
                let idx = pos as usize;
                pits[player][idx] += 1;
                last_side = 0;
                last_pit = idx;
            }
            6 => {
                stores[player] += 1;
                last_side = 1;
            }
            7..=12 => {
                let idx = (pos - 7) as usize;
                pits[opponent][idx] += 1;
                last_side = 2;
                last_pit = idx;
            }
            _ => {}
        }
    }

    let mut capture_seeds = 0u8;
    if last_side == 0 && pits[player][last_pit] == 1 {
        let opposite = PITS - 1 - last_pit;
        if pits[opponent][opposite] > 0 {
            capture_seeds = pits[player][last_pit] + pits[opponent][opposite];
            stores[player] += capture_seeds;
            pits[player][last_pit] = 0;
            pits[opponent][opposite] = 0;
        }
    }

    let extra_turn = last_side == 1;
    let mut next_board = Board {
        pits,
        stores,
        current_player: if extra_turn { player } else { opponent },
        game_over: false,
    };

    let p0_empty = next_board.pits[0].iter().all(|&count| count == 0);
    let p1_empty = next_board.pits[1].iter().all(|&count| count == 0);
    if p0_empty || p1_empty {
        for idx in 0..PITS {
            next_board.stores[0] += next_board.pits[0][idx];
            next_board.stores[1] += next_board.pits[1][idx];
            next_board.pits[0][idx] = 0;
            next_board.pits[1][idx] = 0;
        }
        next_board.game_over = true;
    }

    Some(MoveResult {
        board: next_board,
        extra_turn,
        capture_seeds,
        immediate_score: i32::from(next_board.stores[player]) - i32::from(board.stores[player]),
    })
}

fn ordered_legal_moves(board: &Board) -> Vec<usize> {
    let player = board.current_player;
    let mut moves = Vec::with_capacity(PITS);
    for pit in legal_moves(board, player) {
        if let Some(result) = simulate_move(board, player, pit) {
            let priority = (if result.board.game_over { 10_000 } else { 0 })
                + (if result.extra_turn { 5_000 } else { 0 })
                + (i32::from(result.capture_seeds) * 100)
                + (result.immediate_score * 10)
                + pit as i32;
            moves.push((priority, pit));
        }
    }
    moves.sort_by(|a, b| b.cmp(a));
    moves.into_iter().map(|(_, pit)| pit).collect()
}

fn sum_side_pits(board: &Board, player: usize) -> i32 {
    board.pits[player].iter().map(|&count| i32::from(count)).sum()
}

fn mobility(board: &Board, player: usize) -> i32 {
    legal_moves(board, player).len() as i32
}

fn count_extra_turn_moves(board: &Board, player: usize) -> i32 {
    legal_moves(board, player)
        .into_iter()
        .filter_map(|pit| simulate_move(board, player, pit))
        .filter(|result| result.extra_turn && !result.board.game_over)
        .count() as i32
}

fn best_capture(board: &Board, player: usize) -> i32 {
    legal_moves(board, player)
        .into_iter()
        .filter_map(|pit| simulate_move(board, player, pit))
        .map(|result| i32::from(result.capture_seeds))
        .max()
        .unwrap_or(0)
}

fn evaluate(board: &Board, maximizing_player: usize) -> i32 {
    let opponent = 1 - maximizing_player;
    let store_diff = i32::from(board.stores[maximizing_player]) - i32::from(board.stores[opponent]);

    if board.game_over {
        return store_diff * TERMINAL_SCORE_WEIGHT;
    }

    let pit_diff = sum_side_pits(board, maximizing_player) - sum_side_pits(board, opponent);
    let mobility_diff = mobility(board, maximizing_player) - mobility(board, opponent);
    let extra_turn_diff = count_extra_turn_moves(board, maximizing_player) - count_extra_turn_moves(board, opponent);
    let capture_diff = best_capture(board, maximizing_player) - best_capture(board, opponent);

    store_diff * STORE_SCORE_WEIGHT
        + pit_diff * PIT_SCORE_WEIGHT
        + extra_turn_diff * EXTRA_TURN_WEIGHT
        + capture_diff * CAPTURE_WEIGHT
        + mobility_diff * MOBILITY_WEIGHT
}

fn search(
    board: &Board,
    maximizing_player: usize,
    depth: u32,
    mut alpha: i32,
    mut beta: i32,
    deadline_ms: Option<f64>,
) -> SearchResult {
    if let Some(deadline) = deadline_ms {
        if current_time_ms() >= deadline {
            return SearchResult {
                score: evaluate(board, maximizing_player),
                best_move: -1,
                completed: false,
            };
        }
    }

    if depth == 0 || board.game_over {
        return SearchResult {
            score: evaluate(board, maximizing_player),
            best_move: -1,
            completed: true,
        };
    }

    let moves = ordered_legal_moves(board);
    if moves.is_empty() {
        return SearchResult {
            score: evaluate(board, maximizing_player),
            best_move: -1,
            completed: true,
        };
    }

    let maximizing_turn = board.current_player == maximizing_player;
    let mut best_move = moves[0] as i32;
    let mut best_score = if maximizing_turn { i32::MIN } else { i32::MAX };

    for pit in moves {
        let result = match simulate_move(board, board.current_player, pit) {
            Some(result) => result,
            None => continue,
        };
        let child = search(
            &result.board,
            maximizing_player,
            depth - 1,
            alpha,
            beta,
            deadline_ms,
        );
        if !child.completed {
            return SearchResult {
                score: child.score,
                best_move,
                completed: false,
            };
        }

        if maximizing_turn {
            if child.score > best_score {
                best_score = child.score;
                best_move = pit as i32;
            }
            alpha = alpha.max(best_score);
        } else {
            if child.score < best_score {
                best_score = child.score;
                best_move = pit as i32;
            }
            beta = beta.min(best_score);
        }

        if alpha >= beta {
            break;
        }
    }

    SearchResult {
        score: best_score,
        best_move,
        completed: true,
    }
}

fn choose_move_for_depth(board: Board, max_depth: u32) -> i32 {
    let depth = max_depth.max(1);
    search(&board, board.current_player, depth, i32::MIN, i32::MAX, None).best_move
}

fn pack_timed_search_result(best_move: i32, completed_depth: u32) -> u64 {
    let move_bits = u32::from_ne_bytes(best_move.to_ne_bytes());
    (u64::from(completed_depth) << 32) | u64::from(move_bits)
}

fn pack_score_search_result(score: i32, completed_depth: u32) -> u64 {
    let score_bits = u32::from_ne_bytes(score.to_ne_bytes());
    (u64::from(completed_depth) << 32) | u64::from(score_bits)
}

fn choose_move_for_time(board: Board, time_budget_ms: u32) -> (u8, u32) {
    let legal = ordered_legal_moves(&board);
    debug_assert!(!legal.is_empty(), "choose_move_for_time requires at least one legal move");
    if time_budget_ms == 0 {
        return (legal[0] as u8, 0);
    }

    let deadline = current_time_ms() + f64::from(time_budget_ms);
    let mut best_move = legal[0] as u8;
    let mut depth = 1u32;
    let mut last_completed_depth = 0u32;

    loop {
        let result = search(&board, board.current_player, depth, i32::MIN, i32::MAX, Some(deadline));
        if !result.completed {
            break;
        }
        best_move = result.best_move as u8;
        last_completed_depth = depth;
        if depth == u32::MAX {
            break;
        }
        depth += 1;
    }

    (best_move, last_completed_depth)
}

#[unsafe(no_mangle)]
pub extern "C" fn mancala_solver_choose_move_for_depth(
    p0_0: u8,
    p0_1: u8,
    p0_2: u8,
    p0_3: u8,
    p0_4: u8,
    p0_5: u8,
    p1_0: u8,
    p1_1: u8,
    p1_2: u8,
    p1_3: u8,
    p1_4: u8,
    p1_5: u8,
    store0: u8,
    store1: u8,
    current_player: u8,
    max_depth: u32,
) -> i32 {
    choose_move_for_depth(
        build_board([
            p0_0, p0_1, p0_2, p0_3, p0_4, p0_5, p1_0, p1_1, p1_2, p1_3, p1_4, p1_5, store0,
            store1, current_player,
        ]),
        max_depth,
    )
}

#[unsafe(no_mangle)]
pub extern "C" fn mancala_solver_choose_move_for_time(
    p0_0: u8,
    p0_1: u8,
    p0_2: u8,
    p0_3: u8,
    p0_4: u8,
    p0_5: u8,
    p1_0: u8,
    p1_1: u8,
    p1_2: u8,
    p1_3: u8,
    p1_4: u8,
    p1_5: u8,
    store0: u8,
    store1: u8,
    current_player: u8,
    time_budget_ms: u32,
) -> u64 {
    let board = build_board([
        p0_0, p0_1, p0_2, p0_3, p0_4, p0_5, p1_0, p1_1, p1_2, p1_3, p1_4, p1_5, store0,
        store1, current_player,
    ]);
    if ordered_legal_moves(&board).is_empty() {
        return pack_timed_search_result(-1, 0);
    }
    let (best_move, completed_depth) = choose_move_for_time(board, time_budget_ms);
    pack_timed_search_result(i32::from(best_move), completed_depth)
}

#[unsafe(no_mangle)]
pub extern "C" fn mancala_solver_search_score_for_time(
    p0_0: u8,
    p0_1: u8,
    p0_2: u8,
    p0_3: u8,
    p0_4: u8,
    p0_5: u8,
    p1_0: u8,
    p1_1: u8,
    p1_2: u8,
    p1_3: u8,
    p1_4: u8,
    p1_5: u8,
    store0: u8,
    store1: u8,
    current_player: u8,
    maximizing_player: u8,
    max_depth: u32,
    time_budget_ms: u32,
) -> u64 {
    let board = build_board([
        p0_0, p0_1, p0_2, p0_3, p0_4, p0_5, p1_0, p1_1, p1_2, p1_3, p1_4, p1_5, store0,
        store1, current_player,
    ]);
    let depth = max_depth;
    let deadline_ms = Some(current_time_ms() + f64::from(time_budget_ms));
    let result = search(
        &board,
        usize::from(maximizing_player.min(1)),
        depth,
        i32::MIN,
        i32::MAX,
        deadline_ms,
    );
    let completed_depth = if result.completed { depth } else { 0 };
    pack_score_search_result(result.score, completed_depth)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn board(
        pits: [[u8; PITS]; 2],
        stores: [u8; 2],
        current_player: usize,
    ) -> Board {
        Board {
            pits,
            stores,
            current_player,
            game_over: false,
        }
    }

    #[test]
    fn simulate_move_handles_capture_rule() {
        let state = board([[0, 0, 1, 0, 0, 0], [0, 0, 4, 0, 0, 0]], [10, 8], 0);
        let result = simulate_move(&state, 0, 2).expect("legal move");
        assert_eq!(result.capture_seeds, 5);
        assert_eq!(result.board.stores, [15, 8]);
        assert_eq!(result.board.pits[0][3], 0);
        assert_eq!(result.board.pits[1][2], 0);
    }

    #[test]
    fn depth_search_prefers_extra_turn() {
        let state = board([[0, 0, 0, 0, 2, 1], [4, 4, 4, 4, 4, 4]], [0, 0], 0);
        assert_eq!(choose_move_for_depth(state, 4), 5);
    }

    #[test]
    fn time_search_returns_legal_move_without_clock() {
        let state = board([[4, 4, 4, 4, 4, 4], [4, 4, 4, 4, 4, 4]], [0, 0], 0);
        let (choice, completed_depth) = choose_move_for_time(state, 1);
        assert!((0..PITS as u8).contains(&choice));
        assert!(completed_depth <= u32::MAX);
    }
}
