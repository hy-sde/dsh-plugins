//! dsh-omp-native — standalone sidecar extracted from the oh-my-pi (omp) Rust
//! rewrite. Serves two bounded, read-only capabilities to the DeepSeek Harness:
//!
//!   dsh-omp-native pdf    <input.pdf> <page>          → PNG page raster, JSON
//!   dsh-omp-native sqlite <db-path> <authored-target> → text rendering, JSON
//!
//! Contract (pinned in docs/cli-contract.md): one JSON document on stdout;
//! exit 0 for `{"ok": ...}`, non-zero (1) for `{"error": ...}`. Every input is
//! bounded by the same ceilings the omp2 tools enforce internally.

mod pdf;
mod sqlite;

use std::ffi::OsString;
use std::fs;
use std::io;

use bytes::Bytes;
use serde_json::{Value, json};

use crate::pdf::{PdfRasterError, RasterizedPage};

// base64 without pulling a dependency: encode to a compact JSON string.
fn encode_base64(input: &[u8]) -> String {
	const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
	let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
	for chunk in input.chunks(3) {
		let b0 = chunk[0] as u32;
		let b1 = chunk.get(1).copied().unwrap_or(0) as u32;
		let b2 = chunk.get(2).copied().unwrap_or(0) as u32;
		let n = (b0 << 16) | (b1 << 8) | b2;
		out.push(TABLE[(n >> 18) as usize & 63] as char);
		out.push(TABLE[(n >> 12) as usize & 63] as char);
		out.push(if chunk.len() > 1 { TABLE[(n >> 6) as usize & 63] as char } else { '=' });
		out.push(if chunk.len() > 2 { TABLE[n as usize & 63] as char } else { '=' });
	}
	out
}

fn read_input(path: &str) -> Result<Bytes, String> {
	let bytes =
		fs::read(path).map_err(|error| format!("cannot open input '{path}': {error}"))?;
	Ok(Bytes::from(bytes))
}

fn pdf_ok(result: &RasterizedPage, data_base64: String) -> Value {
	json!({
		"ok": {
			"media_type": result.media_type,
			"page": result.page,
			"total_pages": result.total_pages,
			"width": result.width,
			"height": result.height,
			"data_base64": data_base64,
		}
	})
}

fn pdf_error(error: &PdfRasterError) -> Value {
	json!({
		"error": {
			"kind": "pdf",
			"message": error.to_string(),
			"detail": match error {
				PdfRasterError::InputTooLarge { max_bytes } => json!({"max_bytes": max_bytes}),
				PdfRasterError::TooManyPages { pages, max_pages } => json!({"pages": pages, "max_pages": max_pages}),
				PdfRasterError::PageOutOfRange { page, total_pages } => json!({"page": page, "total_pages": total_pages}),
				_ => json!(null),
			},
		}
	})
}

fn run_pdf(args: &[OsString]) -> i32 {
	if args.len() != 2 {
		eprintln!("usage: dsh-omp-native pdf <input.pdf> <page>");
		return 2;
	}
	let input = match read_input(&args[0].to_string_lossy()) {
		Ok(bytes) => bytes,
		Err(message) => {
			println!("{}", json!({"error": {"kind": "io", "message": message}}));
			return 1;
		},
	};
	let page: usize = match args[1].to_string_lossy().parse() {
		Ok(page) if page >= 1 => page,
		_ => {
			println!("{}", json!({"error": {"kind": "usage", "message": "page must be a positive integer"}}));
			return 2;
		},
	};
	match pdf::rasterize_page(input, page) {
		Ok(result) => {
			let encoded = encode_base64(&result.data);
			println!("{}", pdf_ok(&result, encoded));
			0
		},
		Err(error) => {
			println!("{}", pdf_error(&error));
			1
		},
	}
}

fn run_sqlite(args: &[OsString]) -> i32 {
	if args.len() != 1 {
		eprintln!("usage: dsh-omp-native sqlite <target>");
		return 2;
	}
	let target = args[0].to_string_lossy().to_string();
	let candidate = match crate::sqlite::parse_path_candidates(&target).into_iter().next() {
		Some(candidate) => candidate,
		None => {
			println!(
				"{}",
				json!({"error": {"kind": "usage", "message": "target must embed a .sqlite/.db path, e.g. data.sqlite:users?limit=10"}})
			);
			return 2;
		},
	};
	match crate::sqlite::read_path(&candidate.sqlite_path, &candidate.sub_path, &candidate.query_string) {
		Ok(text) => {
			println!("{}", json!({"ok": {"text": text}}));
			0
		},
		Err(error) => {
			println!("{}", json!({"error": {"kind": "sqlite", "message": error.to_string()}}));
			1
		},
	}
}

fn main() {
	let args: Vec<OsString> = std::env::args_os().skip(1).collect();
	let code = match args.first().map(|arg| arg.to_string_lossy().to_string()).as_deref() {
		Some("pdf") => run_pdf(&args[1..]),
		Some("sqlite") => run_sqlite(&args[1..]),
		Some("--help" | "-h") => {
			println!("dsh-omp-native <command>\n\ncommands:\n  pdf     <input.pdf> <page>      rasterize one page to PNG\n  sqlite  <db-path> <target>     read-only query, pi target syntax");
			0
		},
		_ => {
			eprintln!("unknown command; use --help");
			2
		},
	};
	io::Write::flush(&mut io::stdout()).ok();
	std::process::exit(code);
}
