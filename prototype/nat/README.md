# piik-nat-lab

一个很小的命令行工具：看看你所在的网络怎样给向外的连接分配端口。两个人能不能直接连上，很大程度取决于这一点。

## 它做什么，不做什么

- 向十几个公共 STUN 服务器和我们自己的一台服务器各发几个很小的 UDP 询问包，问“你看到我从哪个地址和端口来”，然后把结果打印出来。通常不到一分钟；最坏情况下所有等待加起来约三分钟，域名解析另计。
- 我们自己的那台服务器还会被请求“换一个端口回我一个包”，报告只记录这一次从哪些来源收到了回复，不给你的网络下结论。
- 除了这些询问包，不发送任何东西；不扫描，不上传，不改动任何设置。服务器那边不记录谁问过它。
- 报告里你的公网地址只显示一半，本机地址只显示类别（私有地址、运营商地址等）。

## 怎么运行

- Windows：解压后双击 `运行.bat`。结果显示在窗口里，同时存成同一文件夹下的 `report.txt`。第一次运行时 Windows 可能提示“已保护你的电脑”，点“更多信息”再点“仍要运行”。也可以在终端里直接运行 `piik-nat-lab.exe`，它自己不写任何文件。
- macOS、Linux：`chmod +x piik-nat-lab`，然后 `./piik-nat-lab`。

不要加 `--full`，它会打印完整的公网地址。

如果开着 VPN 或代理，测到的可能是它的出口而不是你的网络；工具看到多个公网地址时会在报告里写明，并分别判读。能关就关掉再跑一次，不方便关就在回传时说明。不要为了测试去改你无权改动的网络设置。

## 回传什么

把 `report.txt` 发给请你测试的人（或者把 `==== report (copy from here) ====` 到 `==== end of report ====` 之间的整段文字复制下来），并写一句这是什么网络：家里宽带、校园网、手机热点、公司网络，哪家运营商。同一个网络跑一次就够；换一个网络欢迎再跑。

## In English

`piik-nat-lab` asks public STUN servers and a server of our own which address and port they see for this machine, asks ours to answer once from another of its ports, and prints which answers came in and what the mappings say about the NAT in front of it. It sends nothing else, uploads nothing and changes no setting, and the server keeps no record of who asked. The report shows half of the public address. Run it without arguments (on Windows, `运行.bat` also keeps a copy in `report.txt`), and send the report with one line saying what kind of network it was. Do not pass `--full`.

## For whoever reads the reports

`cargo run --example replay -- [--drop <text in an observer's name>] [--only <address letter>] report.txt...` replays pasted reports offline: how often the aim read from earlier mappings would have held each new one, at several packet budgets. No packet is sent. A report says which of its observers are one address by number (`observer address groups`), since names alone do not: the replay reads its destinations from that line.

## The server of our own

`piik-nat-observer <first port> <count> [address to bind]` answers STUN Binding requests on a run of UDP ports, and answers from the next port of the run when a request asks for another port. It has one address, keeps nothing and prints nothing about who asked. `OWN_OBSERVER` in `src/main.rs` names the one the tool asks; `--observer <host>:<first port>-<last port>` asks another in its place. A report names its ports `own1:<port>`, and those of a second address `own2:<port>`. A run whose first port does not answer is not asked further, so a server that is down costs one wait and not sixteen; the report counts those ports as not asked.

A run that leaves this machine nowhere: start `piik-nat-observer 41000 16 127.0.0.1` and `piik-nat-observer 41100 4 127.0.0.2`, then `piik-nat-lab --own-only --observer 127.0.0.1:41000-41015 --observer 127.0.0.2:41100-41103`.

## Building

No dependencies. `cargo build --release` in this directory gives `target/release/piik-nat-lab` and `target/release/piik-nat-observer`; `cargo test` runs the model's tests against the simulator. `package/windows/run.bat` is the Windows launcher, shipped beside the executable as `运行.bat`.
