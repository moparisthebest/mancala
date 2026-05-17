use std::time::Instant;

use mancala_solver::{Board, PITS, SearchConfig, apply_move, choose_move_for_time, initial_board};

const DEFAULT_EXPLORE_BUDGET_MS: u32 = 100;
const DEFAULT_FINAL_BUDGET_MS: u32 = 2_000;
const DEFAULT_CYCLES: usize = 2;
const FACTORS: [f64; 4] = [0.5, 0.75, 1.25, 1.5];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct CliOptions {
    explore_budget_ms: u32,
    final_budget_ms: u32,
    cycles: usize,
}

#[derive(Clone, Copy, Debug)]
struct SeatTiming {
    moves: u32,
    total_elapsed_ms: f64,
    max_elapsed_ms: f64,
    max_completed_depth: u32,
}

#[derive(Clone, Copy, Debug)]
struct GameReport {
    final_board: Board,
    plies: u32,
    seat_timings: [SeatTiming; 2],
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
struct CandidateScore {
    outcome_points: i32,
    margin: i32,
}

fn main() {
    let options = parse_args();
    let default_config = SearchConfig::default();
    let mut best_player1 = default_config;
    let mut best_player2 = default_config;

    println!("Exploration budget: {}ms/move", options.explore_budget_ms);
    println!("Final validation budget: {}ms/move", options.final_budget_ms);
    println!("Optimization cycles: {}", options.cycles);
    println!();

    for cycle in 0..options.cycles {
        println!("=== Optimization cycle {} ===", cycle + 1);
        let optimized_player1 = optimize_for_seat(
            0,
            best_player1,
            best_player2,
            options.explore_budget_ms,
        );
        let optimized_player2 = optimize_for_seat(
            1,
            best_player2,
            optimized_player1,
            options.explore_budget_ms,
        );
        let changed = optimized_player1 != best_player1 || optimized_player2 != best_player2;
        best_player1 = optimized_player1;
        best_player2 = optimized_player2;
        println!("Best player 1 config: {}", format_config(&best_player1));
        println!("Best player 2 config: {}", format_config(&best_player2));
        println!();
        if !changed {
            break;
        }
    }

    println!("=== Final validation at {}ms/move ===", options.final_budget_ms);
    let asymmetric = play_game(best_player1, best_player2, options.final_budget_ms);
    let player1_symmetric = play_game(best_player1, best_player1, options.final_budget_ms);
    let player2_symmetric = play_game(best_player2, best_player2, options.final_budget_ms);
    let default_symmetric = play_game(default_config, default_config, options.final_budget_ms);

    print_match_report(
        "Best player1 vs best player2",
        &asymmetric,
        best_player1,
        best_player2,
    );
    print_match_report(
        "Best player1 mirrored",
        &player1_symmetric,
        best_player1,
        best_player1,
    );
    print_match_report(
        "Best player2 mirrored",
        &player2_symmetric,
        best_player2,
        best_player2,
    );
    print_match_report(
        "Default mirrored",
        &default_symmetric,
        default_config,
        default_config,
    );

    println!("=== Verdict ===");
    println!("Best config for player 1: {}", format_config(&best_player1));
    println!("Best config for player 2: {}", format_config(&best_player2));
    if best_player1 == best_player2 {
        println!("Result: the same parameter set won for both seats.");
    } else {
        println!("Result: player 1 and player 2 prefer different parameter sets.");
    }
}

fn parse_args() -> CliOptions {
    let mut options = CliOptions {
        explore_budget_ms: DEFAULT_EXPLORE_BUDGET_MS,
        final_budget_ms: DEFAULT_FINAL_BUDGET_MS,
        cycles: DEFAULT_CYCLES,
    };

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--explore-budget-ms" => {
                options.explore_budget_ms =
                    parse_u32_arg("--explore-budget-ms", args.next().as_deref());
            }
            "--final-budget-ms" => {
                options.final_budget_ms =
                    parse_u32_arg("--final-budget-ms", args.next().as_deref());
            }
            "--cycles" => {
                options.cycles = parse_usize_arg("--cycles", args.next().as_deref());
            }
            "--help" | "-h" => {
                print_help_and_exit(0);
            }
            other => {
                eprintln!("Unknown argument: {other}");
                print_help_and_exit(1);
            }
        }
    }

    options
}

fn parse_u32_arg(flag: &str, value: Option<&str>) -> u32 {
    value
        .unwrap_or_else(|| {
            eprintln!("Missing value for {flag}");
            print_help_and_exit(1);
        })
        .parse::<u32>()
        .unwrap_or_else(|err| {
            eprintln!("Invalid value for {flag}: {err}");
            print_help_and_exit(1);
        })
}

fn parse_usize_arg(flag: &str, value: Option<&str>) -> usize {
    value
        .unwrap_or_else(|| {
            eprintln!("Missing value for {flag}");
            print_help_and_exit(1);
        })
        .parse::<usize>()
        .unwrap_or_else(|err| {
            eprintln!("Invalid value for {flag}: {err}");
            print_help_and_exit(1);
        })
}

fn print_help_and_exit(code: i32) -> ! {
    let program = std::env::args()
        .next()
        .unwrap_or_else(|| "self_play_tune".to_string());
    println!(
        "Usage: {program} [--explore-budget-ms N] [--final-budget-ms N] [--cycles N]\n\
         \n\
         Runs a deterministic self-play tuner around the current solver defaults.\n\
         Exploration uses a short move budget to search nearby parameter sets.\n\
         Final validation reruns the winning configs with the requested long budget."
    );
    std::process::exit(code);
}

fn optimize_for_seat(
    target_seat: usize,
    current: SearchConfig,
    opponent: SearchConfig,
    budget_ms: u32,
) -> SearchConfig {
    println!(
        "Optimizing player {} against {}",
        target_seat + 1,
        format_config(&opponent)
    );
    let mut best_config = current;
    let mut best_score = evaluate_candidate(target_seat, current, opponent, budget_ms);
    println!(
        "  baseline => outcome {} margin {}",
        best_score.outcome_points, best_score.margin
    );

    for candidate in generate_neighbor_configs(current) {
        let score = evaluate_candidate(target_seat, candidate, opponent, budget_ms);
        if score > best_score {
            best_config = candidate;
            best_score = score;
            println!(
                "  improved => outcome {} margin {} :: {}",
                score.outcome_points,
                score.margin,
                format_config(&best_config)
            );
        }
    }

    best_config
}

fn evaluate_candidate(
    target_seat: usize,
    candidate: SearchConfig,
    opponent: SearchConfig,
    budget_ms: u32,
) -> CandidateScore {
    let report = if target_seat == 0 {
        play_game(candidate, opponent, budget_ms)
    } else {
        play_game(opponent, candidate, budget_ms)
    };
    let margin = report.final_board.stores[target_seat] as i32
        - report.final_board.stores[1 - target_seat] as i32;
    let outcome_points = if margin > 0 {
        3
    } else if margin == 0 {
        1
    } else {
        0
    };
    CandidateScore {
        outcome_points,
        margin,
    }
}

fn generate_neighbor_configs(base: SearchConfig) -> Vec<SearchConfig> {
    let mut configs = Vec::new();

    for factor in FACTORS {
        push_unique(
            &mut configs,
            SearchConfig {
                terminal_score_weight: scale_weight(base.terminal_score_weight, factor),
                ..base
            },
        );
        push_unique(
            &mut configs,
            SearchConfig {
                store_score_weight: scale_weight(base.store_score_weight, factor),
                ..base
            },
        );
        push_unique(
            &mut configs,
            SearchConfig {
                pit_score_weight: scale_weight(base.pit_score_weight, factor),
                ..base
            },
        );
        push_unique(
            &mut configs,
            SearchConfig {
                extra_turn_weight: scale_weight(base.extra_turn_weight, factor),
                ..base
            },
        );
        push_unique(
            &mut configs,
            SearchConfig {
                capture_weight: scale_weight(base.capture_weight, factor),
                ..base
            },
        );
        push_unique(
            &mut configs,
            SearchConfig {
                mobility_weight: scale_weight(base.mobility_weight, factor),
                ..base
            },
        );
    }

    configs
}

fn scale_weight(value: i32, factor: f64) -> i32 {
    ((value as f64 * factor).round() as i32).max(1)
}

fn push_unique(configs: &mut Vec<SearchConfig>, config: SearchConfig) {
    if !configs.contains(&config) {
        configs.push(config);
    }
}

fn play_game(player1: SearchConfig, player2: SearchConfig, budget_ms: u32) -> GameReport {
    let mut board = initial_board();
    let mut plies = 0u32;
    let mut seat_timings = [
        SeatTiming {
            moves: 0,
            total_elapsed_ms: 0.0,
            max_elapsed_ms: 0.0,
            max_completed_depth: 0,
        },
        SeatTiming {
            moves: 0,
            total_elapsed_ms: 0.0,
            max_elapsed_ms: 0.0,
            max_completed_depth: 0,
        },
    ];

    while !board.game_over {
        let current_player = board.current_player;
        let config = if current_player == 0 {
            &player1
        } else {
            &player2
        };
        let start = Instant::now();
        let (pit_idx, completed_depth) = choose_move_for_time(board, budget_ms, config);
        let elapsed_ms = start.elapsed().as_secs_f64() * 1000.0;
        let timing = &mut seat_timings[current_player];
        timing.moves += 1;
        timing.total_elapsed_ms += elapsed_ms;
        timing.max_elapsed_ms = timing.max_elapsed_ms.max(elapsed_ms);
        timing.max_completed_depth = timing.max_completed_depth.max(completed_depth);

        board = apply_move(&board, pit_idx as usize).unwrap_or_else(|| {
            panic!(
                "solver chose illegal pit {} for player {} on board {:?}",
                pit_idx, current_player, board
            )
        });
        plies += 1;
    }

    GameReport {
        final_board: board,
        plies,
        seat_timings,
    }
}

fn print_match_report(
    label: &str,
    report: &GameReport,
    player1: SearchConfig,
    player2: SearchConfig,
) {
    println!("{label}:");
    println!("  player 1 config: {}", format_config(&player1));
    println!("  player 2 config: {}", format_config(&player2));
    println!(
        "  result: stores {}-{}, winner {}",
        report.final_board.stores[0],
        report.final_board.stores[1],
        winner_label(report.final_board.stores)
    );
    println!("  plies: {}", report.plies);
    for seat in 0..2 {
        let timing = report.seat_timings[seat];
        let average_ms = if timing.moves == 0 {
            0.0
        } else {
            timing.total_elapsed_ms / f64::from(timing.moves)
        };
        println!(
            "  player {} timing: moves={}, avg={:.1}ms, max={:.1}ms, max_depth={}",
            seat + 1,
            timing.moves,
            average_ms,
            timing.max_elapsed_ms,
            timing.max_completed_depth
        );
    }
    println!();
}

fn winner_label(stores: [u8; 2]) -> String {
    match stores[0].cmp(&stores[1]) {
        std::cmp::Ordering::Greater => "player 1".to_string(),
        std::cmp::Ordering::Less => "player 2".to_string(),
        std::cmp::Ordering::Equal => "draw".to_string(),
    }
}

fn format_config(config: &SearchConfig) -> String {
    format!(
        "{{ terminal: {}, store: {}, pit: {}, extra_turn: {}, capture: {}, mobility: {} }}",
        config.terminal_score_weight,
        config.store_score_weight,
        config.pit_score_weight,
        config.extra_turn_weight,
        config.capture_weight,
        config.mobility_weight
    )
}

#[allow(dead_code)]
fn _assert_board_shape(board: &Board) {
    for side in board.pits {
        assert_eq!(side.len(), PITS);
    }
}
