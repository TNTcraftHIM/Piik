//! Replays pasted `piik-nat-lab` reports offline: no packet is sent.
//!
//!   cargo run --example replay -- [--drop <text in an observer's name>]... [--only <address letter>] report.txt...
//!
//! A report masks its addresses, so each address letter and each observer host gets a stand-in
//! address; observers on one host share one, as they do in the field.
use piik_nat::mapping::{replay, Allocator, Holdout, Model, Sample};
use std::{collections::BTreeMap, net::{Ipv4Addr, SocketAddrV4}};

fn main() {
    let mut arguments = std::env::args().skip(1);
    let (mut dropped, mut only, mut files) = (Vec::new(), None, Vec::new());
    while let Some(argument) = arguments.next() {
        match argument.as_str() {
            "--drop" => dropped.extend(arguments.next()),
            "--only" => only = arguments.next().and_then(|letter| letter.chars().next()),
            _ => files.push(argument),
        }
    }
    for file in files {
        let text = std::fs::read_to_string(&file).unwrap_or_else(|error| panic!("{file}: {error}"));
        // "observers: 0=stun.example.com:3478 1=..." names each observer index.
        let mut observers = BTreeMap::new();
        let mut hosts: Vec<String> = Vec::new();
        for line in text.lines().filter_map(|line| line.trim().strip_prefix("observers: ")) {
            for entry in line.split_whitespace() {
                let Some((index, name)) = entry.split_once('=') else { continue };
                let Some((host, port)) = name.rsplit_once(':') else { continue };
                let (Ok(index), Ok(port)) = (index.parse::<u16>(), port.parse::<u16>()) else { continue };
                let host_index = hosts.iter().position(|known| known == host).unwrap_or_else(|| {
                    hosts.push(host.to_owned());
                    hosts.len() - 1
                });
                observers.insert(index, (name.to_owned(), SocketAddrV4::new(Ipv4Addr::new(203, 0, 113, host_index as u8 + 1), port)));
            }
        }
        let mut samples = Vec::new();
        for line in text.lines() {
            let fields: Vec<&str> = line.split_whitespace().collect();
            let [socket, observer, sent_ms, letter, mapped, local] = fields[..] else { continue };
            let (Ok(socket), Ok(observer), Ok(sent_ms), Ok(mapped), Ok(local)) =
                (socket.parse(), observer.parse::<u16>(), sent_ms.parse(), mapped.parse(), local.parse()) else { continue };
            let Some(letter) = letter.chars().next().filter(char::is_ascii_uppercase) else { continue };
            let Some((name, address)) = observers.get(&observer) else { continue };
            if dropped.iter().any(|text| name.contains(text.as_str())) || only.is_some_and(|wanted| wanted != letter) {
                continue;
            }
            samples.push(Sample {
                socket,
                local_port: local,
                observer: *address,
                sent_ms,
                mapped: SocketAddrV4::new(Ipv4Addr::new(198, 51, 100, letter as u8 - b'A' + 1), mapped),
            });
        }
        // A socket that shows a port again is reading the mapping it already has.
        let mut made: Vec<Sample> = Vec::new();
        for sample in &samples {
            if !made.iter().any(|earlier| earlier.socket == sample.socket && earlier.mapped == sample.mapped) {
                made.push(*sample);
            }
        }
        println!("\n{file}: {} samples, {} mappings made", samples.len(), made.len());
        match Model::read(&samples).map(|model| model.allocator) {
            Err(unusable) => println!("  model: unusable ({unusable:?})"),
            Ok(Allocator::Point { port, preserved }) => println!("  model: point, port {port}, local port kept: {preserved}"),
            Ok(Allocator::Cursors(cursors)) => println!(
                "  model: {} cursor(s): {}",
                cursors.len(),
                cursors.iter().map(|cursor| format!("{} step {} x{} ({:.1}/s)", cursor.last, cursor.step, cursor.landings, cursor.per_second())).collect::<Vec<_>>().join(", ")
            ),
            Ok(Allocator::Drawn { low, high }) => println!("  model: drawn between {low} and {high}"),
        }
        for (reading, holdout) in [("all earlier mappings", Holdout::Nothing), ("other destinations only", Holdout::Destination), ("other addresses only", Holdout::Address)] {
            let line: Vec<String> = [8u16, 16, 64, 256, 1024]
                .iter()
                .map(|&packets| {
                    let replayed = replay(&made, 8, holdout, packets);
                    format!("{packets}: {}/{}", replayed.held, replayed.held + replayed.missed + replayed.no_aim)
                })
                .collect();
            println!("  held with packets, reading {reading}: {}", line.join("  "));
        }
    }
}
