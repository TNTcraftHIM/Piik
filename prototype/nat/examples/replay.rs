//! Replays pasted `piik-nat-lab` reports offline: no packet is sent.
//!
//!   cargo run --example replay -- [--drop <text in an observer's name>]... [--only <address letter>] report.txt...
//!
//! A report masks its addresses, so each address letter and each observer address gets a
//! stand-in address. Which observers are one address comes from the report's own line of
//! address groups, and from the hosts in the observers' names where a report has no such line.
use piik_nat::mapping::{replay, Allocator, Holdout, Model, Sample};
use std::{collections::BTreeMap, net::{Ipv4Addr, SocketAddrV4}};

fn main() {
    let mut arguments = std::env::args().skip(1);
    let (mut dropped, mut only, mut files) = (Vec::new(), None, Vec::new());
    while let Some(argument) = arguments.next() {
        match argument.as_str() {
            "--drop" => dropped.extend(arguments.next()),
            "--only" => only = arguments.next(),
            _ => files.push(argument),
        }
    }
    for file in files {
        let text = std::fs::read_to_string(&file).unwrap_or_else(|error| panic!("{file}: {error}"));
        // "observers: 0=stun.example.com:3478 1=..." names each observer index.
        let mut observers = BTreeMap::new();
        let mut hosts: Vec<String> = Vec::new();
        // "observer address groups: 1 2 2 3 ..." says which observers are one address. Reports
        // made before that line existed are grouped by the host in an observer's name.
        let groups: Option<Vec<u8>> =
            text.lines().find_map(|line| line.trim().strip_prefix("observer address groups: ")?.split_whitespace().map(|group| group.parse().ok()).collect());
        for line in text.lines().filter_map(|line| line.trim().strip_prefix("observers: ")) {
            for entry in line.split_whitespace() {
                let Some((index, name)) = entry.split_once('=') else { continue };
                let Some((host, port)) = name.rsplit_once(':') else { continue };
                let (Ok(index), Ok(port)) = (index.parse::<u16>(), port.parse::<u16>()) else { continue };
                let group = match &groups {
                    Some(groups) => {
                        let Some(group) = groups.get(usize::from(index)) else { continue };
                        *group
                    }
                    None => {
                        let host_index = hosts.iter().position(|known| known == host).unwrap_or_else(|| {
                            hosts.push(host.to_owned());
                            hosts.len() - 1
                        });
                        host_index as u8 + 1
                    }
                };
                observers.insert(index, (name.to_owned(), SocketAddrV4::new(Ipv4Addr::new(203, 0, 113, group), port)));
            }
        }
        let mut groups = BTreeMap::<&str, Vec<Sample>>::new();
        for line in text.lines() {
            let fields: Vec<&str> = line.split_whitespace().collect();
            let [socket, observer, sent_ms, letter, mapped, local] = fields[..] else { continue };
            let (Ok(socket), Ok(observer), Ok(sent_ms), Ok(mapped), Ok(local)) =
                (socket.parse(), observer.parse::<u16>(), sent_ms.parse(), mapped.parse(), local.parse()) else { continue };
            if !letter.starts_with(|c: char| c.is_ascii_uppercase()) { continue }
            let Some((name, address)) = observers.get(&observer) else { continue };
            if dropped.iter().any(|text| name.contains(text.as_str())) || only.as_deref().is_some_and(|wanted| wanted != letter) {
                continue;
            }
            groups.entry(letter).or_default().push(Sample {
                socket,
                local_port: local,
                observer: *address,
                sent_ms,
                mapped: SocketAddrV4::new(Ipv4Addr::new(198, 51, 100, 1), mapped),
            });
        }
        println!("\n{file}: offline replay assumes the target's public address is known");
        for (letter, samples) in groups {
            read_address(letter, &samples);
        }
    }
}

fn read_address(letter: &str, samples: &[Sample]) {
    // A socket that shows a port again is reading the mapping it already has.
    let mut made: Vec<Sample> = Vec::new();
    for sample in samples {
        if !made.iter().any(|earlier| earlier.socket == sample.socket && earlier.mapped == sample.mapped) {
            made.push(*sample);
        }
    }
    println!("address {letter}: {} samples, {} mappings made", samples.len(), made.len());
    match Model::read(samples).map(|model| model.allocator) {
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
                format!("{packets}: {}/{} ({} warm-up)", replayed.held, replayed.held + replayed.missed + replayed.no_aim, replayed.too_early)
            })
            .collect();
        println!("  held with packets, reading {reading}: {}", line.join("  "));
    }
}
