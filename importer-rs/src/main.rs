use anyhow::{ anyhow, bail, Context, Result };
use chrono::NaiveDate;
use csv::{ ByteRecord, ReaderBuilder, StringRecord, WriterBuilder };
use h3o::{ LatLng, Resolution };
use std::collections::HashMap;
use std::env;
use std::fs::File;
use std::io::{ BufReader, BufWriter };
use std::path::{ Path, PathBuf };
use std::str;
use std::time::Instant;

const MODIS_MIN_CONFIDENCE: i32 = 50;
const SOURCE_MASK_MODIS: u8 = 1;
const SOURCE_MASK_VIIRS: u8 = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Sensor {
    Modis,
    Viirs,
}

impl Sensor {
    fn as_str(self) -> &'static str {
        match self {
            Sensor::Modis => "MODIS",
            Sensor::Viirs => "VIIRS",
        }
    }

    fn source_mask(self) -> u8 {
        match self {
            Sensor::Modis => SOURCE_MASK_MODIS,
            Sensor::Viirs => SOURCE_MASK_VIIRS,
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct InlineStr<const N: usize> {
    buf: [u8; N],
    len: u8,
}

impl<const N: usize> InlineStr<N> {
    fn from_trimmed_ascii(s: &str, uppercase: bool) -> Self {
        let trimmed = s.trim().as_bytes();
        let copy_len = trimmed.len().min(N);
        let mut buf = [0u8; N];
        for (i, &b) in trimmed.iter().take(copy_len).enumerate() {
            buf[i] = if uppercase { b.to_ascii_uppercase() } else { b };
        }
        Self {
            buf,
            len: copy_len as u8,
        }
    }

    fn as_str(&self) -> &str {
        str::from_utf8(&self.buf[..self.len as usize]).unwrap_or("")
    }
}

#[derive(Debug, Clone, Copy)]
struct HotspotValue {
    lat: f64,
    lon: f64,
    frp_mw: f64,
    confidence_pct: u8,
    sensor: Sensor,
    sources: u8,
    satellite: InlineStr<8>,
    daynight: InlineStr<4>,
}

#[derive(Debug)]
struct CliArgs {
    inputs: Vec<PathBuf>,
    out: PathBuf,
    res: u8,
}

fn parse_args() -> Result<CliArgs> {
    let mut inputs = Vec::new();
    let mut out: Option<PathBuf> = None;
    let mut res: u8 = 8;

    let mut args = env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--input" | "-i" => {
                let val = args.next().context("Missing value for --input")?;
                inputs.push(PathBuf::from(val));
            }
            "--out" | "-o" => {
                let val = args.next().context("Missing value for --out")?;
                out = Some(PathBuf::from(val));
            }
            "--res" | "-r" => {
                let val = args.next().context("Missing value for --res")?;
                res = val.parse::<u8>().context("Invalid integer for --res")?;
            }
            "--help" | "-h" => {
                println!(
                    "Usage: import-firms --input <csv> [--input <csv> ...] --out <path.csv> [--res 8]"
                );
                std::process::exit(0);
            }
            other if other.starts_with("--input=") => {
                inputs.push(PathBuf::from(&other["--input=".len()..]));
            }
            other if other.starts_with("--out=") => {
                out = Some(PathBuf::from(&other["--out=".len()..]));
            }
            other if other.starts_with("--res=") => {
                res = other["--res=".len()..]
                    .parse::<u8>()
                    .context("Invalid integer for --res")?;
            }
            other => {
                bail!("Unknown argument: {other}");
            }
        }
    }

    if inputs.is_empty() {
        bail!("At least one --input <csv> argument is required");
    }
    let out = out.context("The --out <path.csv> argument is required")?;

    Ok(CliArgs { inputs, out, res })
}

fn detect_sensor(headers: &StringRecord, source_name: &str) -> Sensor {
    let has_col = |target: &str| headers.iter().any(|h| h.trim() == target);

    if has_col("bright_ti4") || has_col("bright_ti5") {
        return Sensor::Viirs;
    }
    if has_col("brightness") || has_col("bright_t31") {
        return Sensor::Modis;
    }

    let upper_name = source_name.to_ascii_uppercase();
    if upper_name.contains("VIIRS") || upper_name.contains("J1") || upper_name.contains("SNPP") {
        return Sensor::Viirs;
    }
    if upper_name.contains("MODIS") {
        return Sensor::Modis;
    }

    Sensor::Modis
}

fn find_col(headers: &StringRecord, primary: &str, fallback: &str) -> Option<usize> {
    headers
        .iter()
        .position(|h| h.trim() == primary)
        .or_else(|| headers.iter().position(|h| h.trim() == fallback))
}

fn parse_confidence(raw: &str, sensor: Sensor) -> Option<u8> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    match sensor {
        Sensor::Viirs => {
            if trimmed.eq_ignore_ascii_case("nominal") || trimmed.eq_ignore_ascii_case("n") {
                Some(50)
            } else if trimmed.eq_ignore_ascii_case("high") || trimmed.eq_ignore_ascii_case("h") {
                Some(90)
            } else if trimmed.eq_ignore_ascii_case("low") || trimmed.eq_ignore_ascii_case("l") {
                None
            } else if let Ok(num) = trimmed.parse::<f64>() {
                if num == 50.0 {
                    Some(50)
                } else if num == 90.0 {
                    Some(90)
                } else {
                    None
                }
            } else {
                None
            }
        }
        Sensor::Modis => {
            let num = trimmed.parse::<f64>().ok()?;
            if num.is_finite() && (MODIS_MIN_CONFIDENCE as f64..=100.0).contains(&num) {
                Some(num as u8)
            } else {
                None
            }
        }
    }
}

fn read_vm_hwm_kb() -> Option<u64> {
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    for line in status.lines() {
        if let Some(rest) = line.strip_prefix("VmHWM:") {
            let kb_str = rest.split_whitespace().next()?;
            return kb_str.parse::<u64>().ok();
        }
    }
    None
}

fn main() -> Result<()> {
    let start_time = Instant::now();
    let args = parse_args()?;
    let resolution = Resolution::try_from(args.res)
        .map_err(|e| anyhow!("Unsupported H3 resolution {}: {e}", args.res))?;

    let mut rows_read: u64 = 0;
    let mut rows_after_valid_coords_ts: u64 = 0;
    let mut dropped_by_coords_ts: u64 = 0;
    let mut dropped_by_confidence: u64 = 0;
    let mut rows_after_confidence: u64 = 0;
    let mut dropped_by_dedupe: u64 = 0;

    let mut dedup_map: HashMap<(u64, NaiveDate), HotspotValue> =
        HashMap::with_capacity(300_000);

    for input_path in &args.inputs {
        process_csv_file(
            input_path,
            resolution,
            &mut rows_read,
            &mut rows_after_valid_coords_ts,
            &mut dropped_by_coords_ts,
            &mut dropped_by_confidence,
            &mut rows_after_confidence,
            &mut dropped_by_dedupe,
            &mut dedup_map,
        )
        .with_context(|| format!("Failed processing CSV file {}", input_path.display()))?;
    }

    let mut entries: Vec<((u64, NaiveDate), HotspotValue)> = dedup_map.into_iter().collect();
    entries.sort_unstable_by(|a, b| a.0.0.cmp(&b.0.0).then_with(|| a.0.1.cmp(&b.0.1)));

    if let Some(parent) = args.out.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)?;
        }
    }

    let out_file = File::create(&args.out)
        .with_context(|| format!("Failed to create output file {}", args.out.display()))?;
    let mut wtr = WriterBuilder::new().from_writer(BufWriter::with_capacity(256 * 1024, out_file));

    wtr.write_record([
        "ts",
        "sensor",
        "satellite",
        "lat",
        "lon",
        "confidence_pct",
        "frp_mw",
        "daynight",
        "h3_r8",
        "sources",
    ])?;

    let mut distinct_cell_count: u64 = 0;
    let mut prev_cell: Option<u64> = None;
    let mut modis_count: u64 = 0;
    let mut viirs_count: u64 = 0;
    let mut source_counts = [0u64; 4];

    let mut ts_buf = String::with_capacity(10);
    let mut lat_buf = String::with_capacity(24);
    let mut lon_buf = String::with_capacity(24);
    let mut conf_buf = String::with_capacity(8);
    let mut frp_buf = String::with_capacity(24);
    let mut h3_buf = String::with_capacity(24);
    let mut src_buf = String::with_capacity(4);

    for &((h3_r8, ts), ref rec) in &entries {
        if prev_cell != Some(h3_r8) {
            distinct_cell_count += 1;
            prev_cell = Some(h3_r8);
        }
        match rec.sensor {
            Sensor::Modis => modis_count += 1,
            Sensor::Viirs => viirs_count += 1,
        }
        if (rec.sources as usize) < source_counts.len() {
            source_counts[rec.sources as usize] += 1;
        }

        use std::fmt::Write as _;
        ts_buf.clear();
        lat_buf.clear();
        lon_buf.clear();
        conf_buf.clear();
        frp_buf.clear();
        h3_buf.clear();
        src_buf.clear();

        write!(&mut ts_buf, "{}", ts.format("%Y-%m-%d"))?;
        write!(&mut lat_buf, "{}", rec.lat)?;
        write!(&mut lon_buf, "{}", rec.lon)?;
        write!(&mut conf_buf, "{}", rec.confidence_pct)?;
        write!(&mut frp_buf, "{}", rec.frp_mw)?;
        write!(&mut h3_buf, "{}", h3_r8)?;
        write!(&mut src_buf, "{}", rec.sources)?;

        wtr.write_record([
            ts_buf.as_str(),
            rec.sensor.as_str(),
            rec.satellite.as_str(),
            lat_buf.as_str(),
            lon_buf.as_str(),
            conf_buf.as_str(),
            frp_buf.as_str(),
            rec.daynight.as_str(),
            h3_buf.as_str(),
            src_buf.as_str(),
        ])?;
    }
    wtr.flush()?;

    let rows_written = entries.len() as u64;
    let elapsed = start_time.elapsed();
    let vm_hwm_kb = read_vm_hwm_kb().unwrap_or(0);
    let vm_hwm_mb = (vm_hwm_kb as f64) / 1024.0;

    println!("=== NASA Hotspots Rust Importer Summary ===");
    println!("files processed: {}", args.inputs.len());
    println!("rows read: {rows_read}");
    println!("dropped by invalid coords/date: {dropped_by_coords_ts}");
    println!("dropped by confidence: {dropped_by_confidence}");
    println!("rows after confidence: {rows_after_confidence}");
    println!("dropped by dedupe: {dropped_by_dedupe}");
    println!("rows written: {rows_written}");
    println!("distinct cells: {distinct_cell_count}");
    println!("per-sensor counts: VIIRS={viirs_count}, MODIS={modis_count}");
    println!(
        "per-sources-mask counts: 1 (MODIS)={}, 2 (VIIRS)={}, 3 (both)={}",
        source_counts[1], source_counts[2], source_counts[3]
    );
    println!("elapsed time: {:.3} s", elapsed.as_secs_f64());
    println!("peak RSS (VmHWM): {vm_hwm_mb:.2} MB ({vm_hwm_kb} kB)");

    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn process_csv_file(
    path: &Path,
    resolution: Resolution,
    rows_read: &mut u64,
    rows_after_valid_coords_ts: &mut u64,
    dropped_by_coords_ts: &mut u64,
    dropped_by_confidence: &mut u64,
    rows_after_confidence: &mut u64,
    dropped_by_dedupe: &mut u64,
    dedup_map: &mut HashMap<(u64, NaiveDate), HotspotValue>,
) -> Result<()> {
    let file = File::open(path)?;
    let reader = BufReader::with_capacity(256 * 1024, file);
    let mut csv_rdr = ReaderBuilder::new().has_headers(true).from_reader(reader);

    let headers = csv_rdr.headers()?.clone();
    let file_name = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or_default();
    let sensor = detect_sensor(&headers, file_name);
    let mask = sensor.source_mask();

    let lat_idx = find_col(&headers, "latitude", "lat")
        .context("Missing latitude/lat column in CSV header")?;
    let lon_idx = find_col(&headers, "longitude", "lon")
        .context("Missing longitude/lon column in CSV header")?;
    let ts_idx = find_col(&headers, "acq_date", "ts")
        .context("Missing acq_date/ts column in CSV header")?;
    let conf_idx = find_col(&headers, "confidence", "confidence_pct")
        .context("Missing confidence/confidence_pct column in CSV header")?;
    let frp_idx = find_col(&headers, "frp", "frp_mw");
    let sat_idx = find_col(&headers, "satellite", "satellite");
    let dn_idx = find_col(&headers, "daynight", "daynight");

    let mut record = ByteRecord::new();
    while csv_rdr.read_byte_record(&mut record)? {
        *rows_read += 1;

        let lat_opt = record
            .get(lat_idx)
            .and_then(|b| str::from_utf8(b).ok())
            .and_then(|s| s.trim().parse::<f64>().ok())
            .filter(|v| v.is_finite() && (-90.0..=90.0).contains(v));
        let lon_opt = record
            .get(lon_idx)
            .and_then(|b| str::from_utf8(b).ok())
            .and_then(|s| s.trim().parse::<f64>().ok())
            .filter(|v| v.is_finite() && (-180.0..=180.0).contains(v));
        let ts_opt = record
            .get(ts_idx)
            .and_then(|b| str::from_utf8(b).ok())
            .and_then(|s| NaiveDate::parse_from_str(s.trim(), "%Y-%m-%d").ok());

        let (Some(lat), Some(lon), Some(ts)) = (lat_opt, lon_opt, ts_opt) else {
            *dropped_by_coords_ts += 1;
            continue;
        };

        let Ok(latlng) = LatLng::new(lat, lon) else {
            *dropped_by_coords_ts += 1;
            continue;
        };

        *rows_after_valid_coords_ts += 1;

        let conf_raw = record
            .get(conf_idx)
            .and_then(|b| str::from_utf8(b).ok())
            .unwrap_or("");
        let Some(confidence_pct) = parse_confidence(conf_raw, sensor) else {
            *dropped_by_confidence += 1;
            continue;
        };

        *rows_after_confidence += 1;

        let frp_mw = frp_idx
            .and_then(|i| record.get(i))
            .and_then(|b| str::from_utf8(b).ok())
            .and_then(|s| s.trim().parse::<f64>().ok())
            .filter(|v| v.is_finite())
            .unwrap_or(0.0);

        let h3_r8 = u64::from(latlng.to_cell(resolution));
        let key = (h3_r8, ts);

        if let Some(existing) = dedup_map.get_mut(&key) {
            *dropped_by_dedupe += 1;
            existing.sources |= mask;

            let is_better = (confidence_pct > existing.confidence_pct)
                || (confidence_pct == existing.confidence_pct && frp_mw > existing.frp_mw)
                || (confidence_pct == existing.confidence_pct
                    && frp_mw == existing.frp_mw
                    && sensor.as_str() < existing.sensor.as_str());

            if is_better {
                let sat_raw = sat_idx
                    .and_then(|i| record.get(i))
                    .and_then(|b| str::from_utf8(b).ok())
                    .unwrap_or("");
                let dn_raw = dn_idx
                    .and_then(|i| record.get(i))
                    .and_then(|b| str::from_utf8(b).ok())
                    .unwrap_or("");

                existing.sensor = sensor;
                existing.satellite = InlineStr::from_trimmed_ascii(sat_raw, false);
                existing.lat = lat;
                existing.lon = lon;
                existing.confidence_pct = confidence_pct;
                existing.frp_mw = frp_mw;
                existing.daynight = InlineStr::from_trimmed_ascii(dn_raw, true);
            }
        } else {
            let sat_raw = sat_idx
                .and_then(|i| record.get(i))
                .and_then(|b| str::from_utf8(b).ok())
                .unwrap_or("");
            let dn_raw = dn_idx
                .and_then(|i| record.get(i))
                .and_then(|b| str::from_utf8(b).ok())
                .unwrap_or("");

            dedup_map.insert(
                key,
                HotspotValue {
                    lat,
                    lon,
                    frp_mw,
                    confidence_pct,
                    sensor,
                    sources: mask,
                    satellite: InlineStr::from_trimmed_ascii(sat_raw, false),
                    daynight: InlineStr::from_trimmed_ascii(dn_raw, true),
                },
            );
        }
    }

    Ok(())
}
