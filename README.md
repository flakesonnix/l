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
```

## Unterstützter Ausschnitt

- ASCII-Bezeichner, Dezimalzahlen, `//`- und `/* … */`-Kommentare.
- Optionale `module a.b;`-Identität, eine Quelldatei pro Programm.
- `int` (exakt 32 Bit), `bool`, `void`-Funktionen, lokale Typinferenz mit `auto`.
- Initialisierte lokale Variablen, `const`, lexikalische Sichtbarkeit/Shadowing.
- Direkte Funktionsaufrufe, Vorwärtsreferenzen, Rekursion und Wertparameter.
- Blöcke, `if`/`else`, `while`, `for`, `return`, leere Statements.
- `=`, nachgestelltes `++`/`--`, unäres `+`/`-`/`!`, `+ - * / %`, Vergleiche,
  `&&`/`||` mit Kurzschlussauswertung und C-Operatorrangfolge.

Keine impliziten Konversionen zwischen `int` und `bool`. Bedingungen sind `bool`.
Alle lokalen Deklarationen brauchen Initialisierer; alle Parameter und
Funktionsrückgaben explizite Typen. Eintrittspunkt: `int main()`.
Nicht-`void`-Funktionen müssen strukturell auf allen Pfaden zurückkehren;
eine Schleife allein gilt noch nicht als Rückgabebeweis. Auswertungsreihenfolge
für Operanden und Argumente: links nach rechts.

Overflow, Division/Rest durch null und `INT32_MIN / -1` bzw. `% -1` lösen
definierte Traps aus, ohne C-Overflow-UB. Die VM begrenzt Ausführung auf
10 Millionen Instruktionen, Aufruftiefe auf 256 und verwalteten Arbeitsspeicher
auf 128 MiB. Diese Grenzen gehören zum Seed-Profil, nicht zu L allgemein.

Noch nicht implementiert: Imports/Modulauflösung, weitere Primitivtypen,
Strings/IO, Structs/Enums, Arrays/Pointer, Ownership/Borrows, Generics/Concepts,
Dynamic, GC, Klassen, Effects, Native/LLVM, Self-Hosting und Build-/Paketverwaltung.
Die Verzeichnisstruktur täuscht keine Implementierung dieser Subsysteme vor.

## Pipeline und Artefakte

Lexer → AST → Namensauflösung/Typprüfung → typisiertes SSA-Register-IR mit
expliziten lokalen Speicher-Slots → Verifikation → Bytecode → VM.
HIR, Typed IR und MIR werden im Seed noch nicht separat materialisiert.
Es existiert noch kein Ownership-Modell im implementierten Ausschnitt.

IR und Bytecode starten getrennt versioniert mit **1.0**. Der Verifier prüft
Instruktionstypen, Sprungziele, eindeutige Registerdefinitionen, Dominanz,
Initialisierung von Slots, Aufrufsignaturen und Rückgaben. Auch geladener
Bytecode wird vor Ausführung vollständig verifiziert.
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
Die geforderte 100%-Schranke für Zeilen, Funktionen **und Branches** wird erst
als erfüllt bezeichnet, sobald die automatisierte Coverage-Messung dies bestätigt.
