# Language L — Stage 0

C11-Bootstrap für den ersten vertikalen Schnitt der vorgegebenen L-Spezifikation
0.1.0. **Noch keine L-0.1-konforme Implementierung und noch kein vollständiges
L-Core.** Keine LLVM- oder sonstigen Bibliotheksabhängigkeiten.

```sh
make
./build/l check examples/answer.l
./build/l run examples/answer.l                  # Exit-Code 42
./build/l compile examples/answer.l -o build/answer.lbc
./build/l run build/answer.lbc                   # Exit-Code 42
./build/l inspect build/answer.lbc
make test
make sanitize
make coverage                                 # benötigt GCC/gcov und Node.js 22+
```

## Unterstützter Ausschnitt

- ASCII-Bezeichner, Dezimalzahlen, `//`- und `/* … */`-Kommentare.
- Optionale `module a.b;`-Identität, eine Quelldatei pro Programm.
- `int` (exakt 32 Bit), `bool`, `void`-Funktionen, lokale Typinferenz mit `auto`.
- Initialisierte lokale Variablen, `const`, lexikalische Sichtbarkeit/Shadowing.
- Feste lokale `int`-/`bool`-Arrays: `int values[10];`, Indexzugriffe und
  Elementzuweisungen mit Laufzeit-Grenzprüfung.
- Direkte Funktionsaufrufe, Vorwärtsreferenzen, Rekursion und Wertparameter.
- Blöcke, `if`/`else`, `while`, `for`, `return`, leere Statements.
- `=`, nachgestelltes `++`/`--`, unäres `+`/`-`/`!`, `+ - * / %`, Vergleiche,
  `&&`/`||` mit Kurzschlussauswertung und C-Operatorrangfolge.

Keine impliziten Konversionen zwischen `int` und `bool`. Bedingungen sind `bool`.
Skalare lokale Deklarationen brauchen Initialisierer; alle Parameter und
Funktionsrückgaben explizite Typen. Eintrittspunkt: `int main()`.
Nicht-`void`-Funktionen müssen strukturell auf allen Pfaden zurückkehren;
eine Schleife allein gilt noch nicht als Rückgabebeweis. Auswertungsreihenfolge
für Operanden und Argumente: links nach rechts.

Arrays werden bei jeder Ausführung ihrer Deklaration mit `0` bzw. `false`
initialisiert. Ihre Länge ist ein Dezimalliteral von 1 bis 65535; pro Funktion
sind höchstens 65536 Array-Elemente erlaubt. Indexausdrücke müssen `int` sein.
Negative Indizes und Indizes ab der Array-Länge lösen einen definierten Trap aus.
Bei Elementzuweisungen wird der Index genau einmal ausgewertet und geprüft,
bevor die rechte Seite ausgewertet wird. `const`-Arrays erlauben keine
Elementänderungen. Array-Initialisierungslisten, Array-Parameter/-Rückgaben,
Ganzarray-Zuweisungen und mehrdimensionale Arrays sind noch nicht unterstützt.

Overflow, Division/Rest durch null und `INT32_MIN / -1` bzw. `% -1` lösen
definierte Traps aus, ohne C-Overflow-UB. Die VM begrenzt Ausführung auf
10 Millionen Instruktionen, Aufruftiefe auf 256 und verwalteten Arbeitsspeicher
auf 128 MiB. Diese Grenzen gehören zum Seed-Profil, nicht zu L allgemein.

Noch nicht implementiert: Imports/Modulauflösung, weitere Primitivtypen,
Strings/IO, Structs/Enums, Pointer/Slices, Ownership/Borrows, Generics/Concepts,
Dynamic, GC, Klassen, Effects, Native/LLVM, Self-Hosting und Build-/Paketverwaltung.
Die Verzeichnisstruktur täuscht keine Implementierung dieser Subsysteme vor.

## Pipeline und Artefakte

Lexer → AST → Namensauflösung/Typprüfung → typisiertes SSA-Register-IR mit
expliziten lokalen Speicher-Slots → Verifikation → Bytecode → VM.
HIR, Typed IR und MIR werden im Seed noch nicht separat materialisiert.
Es existiert noch kein Ownership-Modell im implementierten Ausschnitt.

IR und Bytecode sind getrennt versioniert, aktuell jeweils **1.1**.
Bytecode 1.1 ergänzt pro Slot eine 32-Bit-Länge (0 für Skalare) sowie
`bounds_check` und `clear`. Der Loader akzeptiert nur die exakte Formatversion;
ältere 1.0-Artefakte müssen aus Quelltext neu kompiliert werden. Der Verifier prüft
Instruktionstypen, Sprungziele, eindeutige Registerdefinitionen, Dominanz,
Initialisierung von Slots, Array-Metadaten, Adressierungsarten,
Aufrufsignaturen und Rückgaben. Indexregister müssen ebenfalls ihre Verwendung
dominieren; Elementzugriffe setzen ein initialisiertes Array voraus. Auch geladener
Bytecode wird vor Ausführung vollständig verifiziert.
Die VM prüft Array-Grenzen zusätzlich direkt bei jedem Elementzugriff, damit
manipulierter Bytecode ohne vorgelagertes `bounds_check` keine Prüfung umgehen kann.
`inspect` zeigt das IR, keine ABI-stabile Textrepräsentation.

Artefakte enthalten keine Zeitstempel oder absoluten Quellpfade. Identische
Quelldateien erzeugen identische Bytecodes, unabhängig vom Eingabepfad.
Das ist **noch kein hermetisches Buildsystem** und keine Stage-2/3-Verifikation.

CLI-Exit-Codes: Programmresultat modulo 256, Verwendung `64`, Compiler-/Formatfehler
`65`, VM-Trap `70`, Start-Speicherfehler `71`, Dateifehler `74`.
Programmresultate können dieselben Zahlen haben; Fehlermeldungen erscheinen auf stderr.

## Tests

`make test` prüft Frontend, Ausführung aus Quelltext und serialisiertem Bytecode,
IR-Roundtrips, reproduzierbare Ausgabe sowie definierte Fehler.
`make sanitize` baut und testet mit AddressSanitizer und UndefinedBehaviorSanitizer.
`make coverage` misst alle Stage-0-C-Dateien ohne Quellcode-Ausschlüsse und
schlägt unter 100% Zeilen-, Funktions- **oder Branch-Coverage** fehl. Es laufen
auch Fault-Injection-, Verifikator- und Bytecode-Mutationstests. Der Bericht steht
unter `build/coverage/report.json`. 100% Coverage ersetzt keinen Korrektheitsbeweis
oder vollständige Sprachkonformität.
