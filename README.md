# Shelly IR Database

A community database of infrared codes for Shelly IR devices.

The codes here are contributed by the people who own the equipment. If your
remote is not in the public databases, or the codes there do not work for your
model, capture it on your own device and open a pull request — the next person
with that appliance gets it for free.

This repository is **not** a mirror of the public IR databases. Those are listed
under [Sources](#sources) and are read directly from their own projects.

## Who is this for?

- **Owners of equipment nobody has mapped yet** — off-brand TVs, projectors, air
  conditioners, fans
- **Anyone whose remote is listed elsewhere but whose codes do not work** — a
  model revision often changes the codes
- **Integrators** building a known-good set for the devices they install

## Contributing

1. Add an IR device in the Shelly web interface and learn the buttons you use,
   pointing the original remote at the blaster.
2. Check each one actually drives the appliance. A code nobody has tested is
   worth little.
3. Export the codes and add the file as
   `codes/<Category>/<Brand>/<Brand>_<Model>.ir`.
4. Open a pull request. Say which appliance you tested it against.

Name the file after the remote or the appliance model, whichever is printed on
the hardware. Categories are plain English and should stay few: `TVs`, `ACs`,
`Audio`, `Projectors`, `Fans`, and so on. Add one only when nothing existing
fits.

Button names should read the way a person would say them: `Power`, `Volume_up`,
`Source`, `Cool_22`. Keep them consistent inside a file.

## File format

Flipper `.ir`, which the Shelly web interface reads directly. Each code is
either `raw` (a list of durations) or `parsed` (a protocol with an address and a
command).

```
Filetype: IR signals file
Version: 1
#
# Acme TV, model X1 — tested on an Acme X1-43
#
name: Power
type: parsed
protocol: NEC
address: 04 00 00 00
command: 08 00 00 00
#
name: Volume_up
type: raw
frequency: 38000
duty_cycle: 0.33
data: 9000 4500 560 1690 560 560 560
```

`data` is unsigned, alternating mark and space, in microseconds, starting with a
mark. `address` and `command` are little-endian hex bytes.

## What makes a code work

A code is only useful if a device can store it and an appliance accepts it:

- **Repeats belong in the signal.** A remote never sends a single frame. Sony
  needs three frames at a 45 ms period; NEC sends one frame followed by short
  repeat bursts. A lone frame is ignored by most appliances, so store what the
  remote actually transmits.
- **Carrier frequency** is 20–60 kHz and defaults to 38 kHz. Sony is 40 kHz,
  RC5/RC6 36 kHz, RCA 56 kHz. A receiver cannot detect the carrier, so a learned
  code always comes back as 38 kHz and may need correcting.
- **Size.** A stored code travels in one RPC frame, so keep it under roughly a
  thousand timings. Ordinary remote buttons are 25–80; air conditioner frames
  run to several hundred.
- **Timings are quantised to 10 µs** by the device, so finer precision is lost.

## Generated files

`index.json` and `fingerprints.json` are built from `codes/` and the public
databases, and committed on `main`, where the web interface reads them. A
nightly workflow (`.github/workflows/build.yml`) rebuilds them and commits them
when their content changed.

### index.json

Lists every remote with its code count, protocol and the models and alternative
brand names it covers, so a client can search the database without walking the
repository. Build it locally with `npx tsx tools/build-index.ts`.

It carries two timestamps. `generated` is when the file was built; `updated`
is when the codes themselves last changed, taken from the last commit touching
each file. That second one is what says how old the data really is.

### fingerprints.json

What lets the web interface name a remote from a couple of button presses. For
every remote in this repository and in the public Flipper databases it records
one entry per protocol and address, with the commands seen on it:

```json
{ "path": "flipper:TVs/LG/LG_AKB75095307.ir", "key": "NEC:04", "commands": "01 02 03 08" }
```

A press is decoded to the same protocol, address and command, which narrows
9 000-odd remotes to a shortlist the user can test. It does not usually name one
remote: many remotes genuinely share an address, and some share commands too.

Only codes stored as a protocol can be fingerprinted. Raw captures - including
everything under `codes/ACs` here - carry no protocol to match, so they are
listed in the index but not here. Build it with
`npx tsx tools/build-fingerprints.ts`, which downloads the source databases.

## Sources

The Shelly IR import feature reads several public databases and builds on
published protocol work. Their files are not copied into this repository:
the web interface reads them from their own projects. `fingerprints.json` is
built from them and holds what identifies each remote (paths, names,
protocols, addresses, commands and frame bits); `codes/ACs` is generated with
IRremoteESP8266. See [NOTICE](NOTICE) for each project's license.

### Code databases

| Project | License | Format | Notes |
| --- | --- | --- | --- |
| [Flipper-IRDB](https://github.com/logickworkshop/Flipper-IRDB) | CC0-1.0 | Flipper `.ir` | Community database, the largest of them |
| [flipperdevices/IRDB](https://github.com/flipperdevices/IRDB) | MIT | Flipper `.ir` | The official Flipper database |
| [LIRC remotes](https://github.com/probonopd/lirc-remotes) | None stated (packaged by distributions as GPL-2.0-or-later) | XML carrying Pronto CCF | Mirror of the [LIRC](https://lirc.sourceforge.net/remotes/) database |
| [SmartIR](https://github.com/smartHomeHub/SmartIR) | MIT | JSON, Broadlink base64 / Pronto | Home Assistant climate, media player and fan codes |
| [WigShop](https://github.com/DAB-LABS/WigShop) | CC0-1.0 | JSON carrying Pronto | Curated remote profiles for [HAIR](https://github.com/DAB-LABS/HAIR) |

### Protocol references

| Project | License | Used for |
| --- | --- | --- |
| [IRremoteESP8266](https://github.com/crankyoldgit/IRremoteESP8266) | LGPL-2.1 | Protocol implementations, especially air conditioners; generated `codes/ACs` (the library is not distributed) |
| [Flipper Zero firmware](https://github.com/flipperdevices/flipperzero-firmware) | GPL-3.0 | Timing constants and bit layouts for the NEC, Samsung, Sony, RC5/RC6, Kaseikyo and RCA families |
| [infrared-protocols](https://github.com/home-assistant-libs/infrared-protocols) | MIT | Home Assistant's own encoder, used to cross-check our output |

Format references: [Girr](https://www.harctoolbox.org/Girr.html), and the Pronto
CCF and Broadlink packet conventions.

## License

Apache License 2.0, see [LICENSE](LICENSE). Third-party sources and their
licenses are listed in [NOTICE](NOTICE).
