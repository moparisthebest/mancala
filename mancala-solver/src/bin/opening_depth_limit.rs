use std::time::Instant;

use mancala_solver::{
    ParallelSearchOptions, SearchConfig, choose_parallel_move_for_depth, initial_board,
};

const DEFAULT_BUDGET_MS: f64 = 2_000.0;
const DEFAULT_MAX_DEPTH: u32 = 20;
const DEFAULT_SAMPLES: usize = 3;

#[derive(Clone, Copy, Debug)]
struct CliOptions {
    budget_ms: f64,
    max_depth: u32,
    samples: usize,
    parallel: ParallelSearchOptions,
}

fn main() {
    let options = parse_args();
    let board = initial_board();
    let config = SearchConfig::default();
    let mut deepest_within_budget = 0u32;

    println!("Opening-state depth benchmark");
    println!("Budget: {:.1}ms", options.budget_ms);
    println!("Max depth to test: {}", options.max_depth);
    println!("Samples per depth: {}", options.samples);
    println!(
        "Parallel search: enabled={}, max_workers={}",
        options.parallel.use_parallel_workers, options.parallel.max_workers
    );
    println!();

    for depth in 1..=options.max_depth {
        let mut timings = Vec::with_capacity(options.samples);
        let mut chosen_move = -1;
        for _ in 0..options.samples {
            let start = Instant::now();
            chosen_move = choose_parallel_move_for_depth(board, depth, &config, &options.parallel);
            timings.push(start.elapsed().as_secs_f64() * 1000.0);
        }
        timings.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));

        let median_ms = timings[timings.len() / 2];
        let best_ms = timings[0];
        let worst_ms = timings[timings.len() - 1];
        println!(
            "depth {:>2}: median {:>8.3}ms, best {:>8.3}ms, worst {:>8.3}ms, move {}",
            depth, median_ms, best_ms, worst_ms, chosen_move
        );

        if median_ms <= options.budget_ms {
            deepest_within_budget = depth;
        } else {
            break;
        }
    }

    println!();
    println!(
        "Deepest opening-state fixed-depth search within {:.1}ms (median): {}",
        options.budget_ms, deepest_within_budget
    );
}

fn parse_args() -> CliOptions {
    let mut options = CliOptions {
        budget_ms: DEFAULT_BUDGET_MS,
        max_depth: DEFAULT_MAX_DEPTH,
        samples: DEFAULT_SAMPLES,
        parallel: ParallelSearchOptions::default(),
    };

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--budget-ms" => {
                options.budget_ms = parse_f64_arg("--budget-ms", args.next().as_deref());
            }
            "--max-depth" => {
                options.max_depth = parse_u32_arg("--max-depth", args.next().as_deref());
            }
            "--samples" => {
                options.samples = parse_usize_arg("--samples", args.next().as_deref());
            }
            "--use-parallel-workers" => {
                options.parallel.use_parallel_workers =
                    parse_bool_arg("--use-parallel-workers", args.next().as_deref());
            }
            "--max-workers" => {
                options.parallel.max_workers =
                    parse_usize_arg("--max-workers", args.next().as_deref()).max(1);
            }
            "--help" | "-h" => print_help_and_exit(0),
            other => {
                eprintln!("Unknown argument: {other}");
                print_help_and_exit(1);
            }
        }
    }

    options
}

fn parse_f64_arg(flag: &str, value: Option<&str>) -> f64 {
    value
        .unwrap_or_else(|| {
            eprintln!("Missing value for {flag}");
            print_help_and_exit(1);
        })
        .parse::<f64>()
        .unwrap_or_else(|err| {
            eprintln!("Invalid value for {flag}: {err}");
            print_help_and_exit(1);
        })
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

fn parse_bool_arg(flag: &str, value: Option<&str>) -> bool {
    match value.unwrap_or_else(|| {
        eprintln!("Missing value for {flag}");
        print_help_and_exit(1);
    }) {
        "true" => true,
        "false" => false,
        other => {
            eprintln!("Invalid value for {flag}: expected true or false, got {other}");
            print_help_and_exit(1);
        }
    }
}

fn print_help_and_exit(code: i32) -> ! {
    let program = std::env::args()
        .next()
        .unwrap_or_else(|| "opening_depth_limit".to_string());
    println!(
        "Usage: {program} [--budget-ms N] [--max-depth N] [--samples N] [--use-parallel-workers true|false] [--max-workers N]\n\
         \n\
         Benchmarks the initial Mancala position and reports the deepest fixed-depth\n\
         search whose median wall-clock runtime stays within the requested budget."
    );
    std::process::exit(code);
}
