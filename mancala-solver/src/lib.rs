pub const PITS: usize = 6;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SearchConfig {
    pub terminal_score_weight: i32,
    pub store_score_weight: i32,
    pub pit_score_weight: i32,
    pub extra_turn_weight: i32,
    pub capture_weight: i32,
    pub mobility_weight: i32,
}

impl Default for SearchConfig {
    fn default() -> Self {
        Self {
            terminal_score_weight: 100_000,
            store_score_weight: 1_000,
            pit_score_weight: 25,
            extra_turn_weight: 40,
            capture_weight: 10,
            mobility_weight: 5,
        }
    }
}

#[cfg(not(target_arch = "wasm32"))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ParallelSearchOptions {
    pub use_parallel_workers: bool,
    pub max_workers: usize,
}

#[cfg(not(target_arch = "wasm32"))]
impl Default for ParallelSearchOptions {
    fn default() -> Self {
        Self {
            use_parallel_workers: true,
            max_workers: 6,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Board {
    pub pits: [[u8; PITS]; 2],
    pub stores: [u8; 2],
    pub current_player: usize,
    pub game_over: bool,
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
    static START: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
    START
        .get_or_init(std::time::Instant::now)
        .elapsed()
        .as_secs_f64()
        * 1000.0
}

#[cfg(not(target_arch = "wasm32"))]
fn parallel_thread_pool(worker_count: usize) -> std::sync::Arc<rayon::ThreadPool> {
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex, OnceLock};

    static POOLS: OnceLock<Mutex<HashMap<usize, Arc<rayon::ThreadPool>>>> = OnceLock::new();
    let pools = POOLS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut pools = pools.lock().expect("parallel pool cache poisoned");
    pools
        .entry(worker_count)
        .or_insert_with(|| {
            Arc::new(
                rayon::ThreadPoolBuilder::new()
                    .num_threads(worker_count)
                    .build()
                    .expect("parallel thread pool"),
            )
        })
        .clone()
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

fn build_search_config(
    terminal_score_weight: i32,
    store_score_weight: i32,
    pit_score_weight: i32,
    extra_turn_weight: i32,
    capture_weight: i32,
    mobility_weight: i32,
) -> SearchConfig {
    SearchConfig {
        terminal_score_weight,
        store_score_weight,
        pit_score_weight,
        extra_turn_weight,
        capture_weight,
        mobility_weight,
    }
}

pub fn initial_board() -> Board {
    Board {
        pits: [[4; PITS], [4; PITS]],
        stores: [0, 0],
        current_player: 0,
        game_over: false,
    }
}

pub fn legal_moves_for_current_player(board: &Board) -> Vec<usize> {
    legal_moves(board, board.current_player)
}

pub fn apply_move(board: &Board, pit_idx: usize) -> Option<Board> {
    simulate_move(board, board.current_player, pit_idx).map(|result| result.board)
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

#[cfg(not(target_arch = "wasm32"))]
fn effective_parallel_worker_count(options: &ParallelSearchOptions, root_move_count: usize) -> usize {
    if !options.use_parallel_workers || root_move_count < 2 {
        return 1;
    }
    let available_workers = std::thread::available_parallelism()
        .map(|value| value.get())
        .unwrap_or(1);
    options
        .max_workers
        .max(1)
        .min(available_workers)
        .min(root_move_count)
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

fn evaluate(board: &Board, maximizing_player: usize, config: &SearchConfig) -> i32 {
    let opponent = 1 - maximizing_player;
    let store_diff = i32::from(board.stores[maximizing_player]) - i32::from(board.stores[opponent]);

    if board.game_over {
        return store_diff * config.terminal_score_weight;
    }

    let pit_diff = sum_side_pits(board, maximizing_player) - sum_side_pits(board, opponent);
    let mobility_diff = mobility(board, maximizing_player) - mobility(board, opponent);
    let extra_turn_diff = count_extra_turn_moves(board, maximizing_player) - count_extra_turn_moves(board, opponent);
    let capture_diff = best_capture(board, maximizing_player) - best_capture(board, opponent);

    store_diff * config.store_score_weight
        + pit_diff * config.pit_score_weight
        + extra_turn_diff * config.extra_turn_weight
        + capture_diff * config.capture_weight
        + mobility_diff * config.mobility_weight
}

fn search(
    board: &Board,
    maximizing_player: usize,
    depth: u32,
    config: &SearchConfig,
    mut alpha: i32,
    mut beta: i32,
    deadline_ms: Option<f64>,
) -> SearchResult {
    if let Some(deadline) = deadline_ms {
        if current_time_ms() >= deadline {
            return SearchResult {
                score: evaluate(board, maximizing_player, config),
                best_move: -1,
                completed: false,
            };
        }
    }

    if depth == 0 || board.game_over {
        return SearchResult {
            score: evaluate(board, maximizing_player, config),
            best_move: -1,
            completed: true,
        };
    }

    let moves = ordered_legal_moves(board);
    if moves.is_empty() {
        return SearchResult {
            score: evaluate(board, maximizing_player, config),
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
            config,
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

pub fn choose_move_for_depth(board: Board, max_depth: u32, config: &SearchConfig) -> i32 {
    let depth = max_depth.max(1);
    search(
        &board,
        board.current_player,
        depth,
        config,
        i32::MIN,
        i32::MAX,
        None,
    )
    .best_move
}

#[cfg(not(target_arch = "wasm32"))]
fn search_root_move(
    child_board: &Board,
    maximizing_player: usize,
    pit: usize,
    depth: u32,
    config: &SearchConfig,
    alpha: i32,
    beta: i32,
    deadline_ms: Option<f64>,
) -> SearchResult {
    let child = search(
        child_board,
        maximizing_player,
        depth.saturating_sub(1),
        config,
        alpha,
        beta,
        deadline_ms,
    );
    SearchResult {
        score: child.score,
        best_move: pit as i32,
        completed: child.completed,
    }
}

#[cfg(not(target_arch = "wasm32"))]
fn search_root_moves_exact_serial(
    board: &Board,
    depth: u32,
    config: &SearchConfig,
    deadline_ms: Option<f64>,
) -> Vec<SearchResult> {
    let maximizing_player = board.current_player;
    ordered_legal_moves(board)
        .into_iter()
        .filter_map(|pit| {
            simulate_move(board, maximizing_player, pit).map(|result| {
                search_root_move(
                    &result.board,
                    maximizing_player,
                    pit,
                    depth,
                    config,
                    i32::MIN,
                    i32::MAX,
                    deadline_ms,
                )
            })
        })
        .collect()
}

#[cfg(not(target_arch = "wasm32"))]
fn search_root_moves_pv_parallel(
    board: &Board,
    depth: u32,
    config: &SearchConfig,
    deadline_ms: Option<f64>,
    worker_count: usize,
) -> Vec<SearchResult> {
    let maximizing_player = board.current_player;
    let root_moves: Vec<(usize, Board)> = ordered_legal_moves(board)
        .into_iter()
        .filter_map(|pit| simulate_move(board, maximizing_player, pit).map(|result| (pit, result.board)))
        .collect();
    if root_moves.is_empty() {
        return Vec::new();
    }

    let (first_pit, first_child_board) = root_moves[0];
    let first_result = search_root_move(
        &first_child_board,
        maximizing_player,
        first_pit,
        depth,
        config,
        i32::MIN,
        i32::MAX,
        deadline_ms,
    );
    if root_moves.len() == 1 || !first_result.completed {
        return vec![first_result];
    }

    let scout_alpha = first_result.score;
    let scout_beta = scout_alpha.saturating_add(1);
    let pool = parallel_thread_pool(worker_count);
    let scout_results = pool.install(|| {
        use rayon::prelude::*;

        root_moves[1..]
            .par_iter()
            .map(|(pit, child_board)| {
                search_root_move(
                    child_board,
                    maximizing_player,
                    *pit,
                    depth,
                    config,
                    scout_alpha,
                    scout_beta,
                    deadline_ms,
                )
            })
            .collect::<Vec<_>>()
    });

    let mut results = Vec::with_capacity(root_moves.len());
    results.push(first_result);
    let mut best_score = first_result.score;

    for ((pit, child_board), scout_result) in root_moves.iter().skip(1).zip(scout_results.into_iter()) {
        if !scout_result.completed {
            results.push(scout_result);
            continue;
        }

        if scout_result.score > best_score {
            let exact_result = search_root_move(
                child_board,
                maximizing_player,
                *pit,
                depth,
                config,
                i32::MIN,
                i32::MAX,
                deadline_ms,
            );
            if exact_result.completed && exact_result.score > best_score {
                best_score = exact_result.score;
            }
            results.push(exact_result);
            continue;
        }

        results.push(scout_result);
    }

    results
}

#[cfg(not(target_arch = "wasm32"))]
fn search_root_moves_exact(
    board: &Board,
    depth: u32,
    config: &SearchConfig,
    deadline_ms: Option<f64>,
    parallel: &ParallelSearchOptions,
) -> Vec<SearchResult> {
    let root_move_count = ordered_legal_moves(board).len();
    let worker_count = effective_parallel_worker_count(parallel, root_move_count);
    if worker_count < 2 {
        return search_root_moves_exact_serial(board, depth, config, deadline_ms);
    }
    search_root_moves_pv_parallel(board, depth, config, deadline_ms, worker_count)
}

#[cfg(not(target_arch = "wasm32"))]
fn select_best_root_result(results: &[SearchResult]) -> Option<SearchResult> {
    let mut best: Option<SearchResult> = None;
    for result in results {
        if best.as_ref().is_none_or(|current| result.score > current.score) {
            best = Some(*result);
        }
    }
    best
}

#[cfg(not(target_arch = "wasm32"))]
pub fn choose_parallel_move_for_depth(
    board: Board,
    max_depth: u32,
    config: &SearchConfig,
    parallel: &ParallelSearchOptions,
) -> i32 {
    let root_move_count = ordered_legal_moves(&board).len();
    let worker_count = effective_parallel_worker_count(parallel, root_move_count);
    if worker_count < 2 {
        return choose_move_for_depth(board, max_depth, config);
    }

    let results = search_root_moves_exact(&board, max_depth.max(1), config, None, parallel);
    select_best_root_result(&results)
        .map(|result| result.best_move)
        .unwrap_or(-1)
}

fn pack_timed_search_result(best_move: i32, completed_depth: u32) -> u64 {
    let move_bits = u32::from_ne_bytes(best_move.to_ne_bytes());
    (u64::from(completed_depth) << 32) | u64::from(move_bits)
}

fn pack_score_search_result(score: i32, completed_depth: u32) -> u64 {
    let score_bits = u32::from_ne_bytes(score.to_ne_bytes());
    (u64::from(completed_depth) << 32) | u64::from(score_bits)
}

pub fn choose_move_for_time(board: Board, time_budget_ms: u32, config: &SearchConfig) -> (u8, u32) {
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
        let result = search(
            &board,
            board.current_player,
            depth,
            config,
            i32::MIN,
            i32::MAX,
            Some(deadline),
        );
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

#[cfg(not(target_arch = "wasm32"))]
pub fn choose_parallel_move_for_time(
    board: Board,
    time_budget_ms: u32,
    config: &SearchConfig,
    parallel: &ParallelSearchOptions,
) -> (u8, u32) {
    let legal = ordered_legal_moves(&board);
    debug_assert!(
        !legal.is_empty(),
        "choose_parallel_move_for_time requires at least one legal move"
    );
    if time_budget_ms == 0 {
        return (legal[0] as u8, 0);
    }

    let worker_count = effective_parallel_worker_count(parallel, legal.len());
    if worker_count < 2 {
        return choose_move_for_time(board, time_budget_ms, config);
    }

    let deadline = current_time_ms() + f64::from(time_budget_ms);
    let mut best_move = legal[0] as u8;
    let mut depth = 1u32;
    let mut last_completed_depth = 0u32;

    loop {
        let results = search_root_moves_exact(&board, depth, config, Some(deadline), parallel);
        if results.iter().any(|result| !result.completed) {
            break;
        }
        if let Some(best_result) = select_best_root_result(&results) {
            best_move = best_result.best_move as u8;
            last_completed_depth = depth;
        }
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
    terminal_score_weight: i32,
    store_score_weight: i32,
    pit_score_weight: i32,
    extra_turn_weight: i32,
    capture_weight: i32,
    mobility_weight: i32,
) -> i32 {
    let config = build_search_config(
        terminal_score_weight,
        store_score_weight,
        pit_score_weight,
        extra_turn_weight,
        capture_weight,
        mobility_weight,
    );
    choose_move_for_depth(
        build_board([
            p0_0, p0_1, p0_2, p0_3, p0_4, p0_5, p1_0, p1_1, p1_2, p1_3, p1_4, p1_5, store0,
            store1, current_player,
        ]),
        max_depth,
        &config,
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
    terminal_score_weight: i32,
    store_score_weight: i32,
    pit_score_weight: i32,
    extra_turn_weight: i32,
    capture_weight: i32,
    mobility_weight: i32,
) -> u64 {
    let config = build_search_config(
        terminal_score_weight,
        store_score_weight,
        pit_score_weight,
        extra_turn_weight,
        capture_weight,
        mobility_weight,
    );
    let board = build_board([
        p0_0, p0_1, p0_2, p0_3, p0_4, p0_5, p1_0, p1_1, p1_2, p1_3, p1_4, p1_5, store0,
        store1, current_player,
    ]);
    if ordered_legal_moves(&board).is_empty() {
        return pack_timed_search_result(-1, 0);
    }
    let (best_move, completed_depth) = choose_move_for_time(board, time_budget_ms, &config);
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
    terminal_score_weight: i32,
    store_score_weight: i32,
    pit_score_weight: i32,
    extra_turn_weight: i32,
    capture_weight: i32,
    mobility_weight: i32,
) -> u64 {
    let config = build_search_config(
        terminal_score_weight,
        store_score_weight,
        pit_score_weight,
        extra_turn_weight,
        capture_weight,
        mobility_weight,
    );
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
        &config,
        i32::MIN,
        i32::MAX,
        deadline_ms,
    );
    let completed_depth = if result.completed { depth } else { 0 };
    pack_score_search_result(result.score, completed_depth)
}

#[unsafe(no_mangle)]
pub extern "C" fn mancala_solver_search_score_window_for_time(
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
    alpha: i32,
    beta: i32,
    terminal_score_weight: i32,
    store_score_weight: i32,
    pit_score_weight: i32,
    extra_turn_weight: i32,
    capture_weight: i32,
    mobility_weight: i32,
) -> u64 {
    let config = build_search_config(
        terminal_score_weight,
        store_score_weight,
        pit_score_weight,
        extra_turn_weight,
        capture_weight,
        mobility_weight,
    );
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
        &config,
        alpha,
        beta,
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
        assert_eq!(choose_move_for_depth(state, 4, &SearchConfig::default()), 5);
    }

    #[test]
    fn time_search_returns_legal_move_without_clock() {
        let state = board([[4, 4, 4, 4, 4, 4], [4, 4, 4, 4, 4, 4]], [0, 0], 0);
        let (choice, completed_depth) = choose_move_for_time(state, 1, &SearchConfig::default());
        assert!((0..PITS as u8).contains(&choice));
        assert!(completed_depth <= u32::MAX);
    }

    #[cfg(not(target_arch = "wasm32"))]
    #[test]
    fn parallel_depth_search_matches_serial_move() {
        let state = board([[4, 4, 4, 4, 4, 4], [4, 4, 4, 4, 4, 4]], [0, 0], 0);
        let config = SearchConfig::default();
        let parallel = ParallelSearchOptions {
            use_parallel_workers: true,
            max_workers: 6,
        };
        assert_eq!(
            choose_parallel_move_for_depth(state, 12, &config, &parallel),
            choose_move_for_depth(state, 12, &config)
        );
    }

    #[cfg(not(target_arch = "wasm32"))]
    #[test]
    fn root_result_selection_keeps_first_best_move() {
        let results = [
            SearchResult {
                score: 10,
                best_move: 5,
                completed: true,
            },
            SearchResult {
                score: 10,
                best_move: 2,
                completed: true,
            },
        ];
        assert_eq!(select_best_root_result(&results).map(|result| result.best_move), Some(5));
    }

    #[cfg(not(target_arch = "wasm32"))]
    #[test]
    fn native_clock_moves_forward() {
        let first = current_time_ms();
        std::thread::sleep(std::time::Duration::from_millis(2));
        let second = current_time_ms();
        assert!(second >= first);
    }
}
