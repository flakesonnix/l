// Header-only syntax check; top-level declarations and resolution are absent.
module l.compiler.header_main;

import l.compiler.lexer as lexer;
import l.compiler.headers as headers;
import std.io as io;

void write_number(int value) {
    if (value >= 10) write_number(value / 10);
    switch (value % 10) {
        case 0: io::write_error("0"); break;
        case 1: io::write_error("1"); break;
        case 2: io::write_error("2"); break;
        case 3: io::write_error("3"); break;
        case 4: io::write_error("4"); break;
        case 5: io::write_error("5"); break;
        case 6: io::write_error("6"); break;
        case 7: io::write_error("7"); break;
        case 8: io::write_error("8"); break;
        case 9: io::write_error("9"); break;
    }
}

int main() {
    lexer::reset();
    int value = io::read_byte();
    while (value != -1) {
        if (!lexer::append(byte(value))) {
            io::write_error("header: source exceeds 65535 bytes\n");
            return 65;
        }
        value = io::read_byte();
    }
    if (headers::parse() != -1) return 0;
    headers::Diagnostic error = headers::diagnostic();
    io::write_error("header:");
    write_number(error.line);
    io::write_error(":");
    write_number(error.column);
    io::write_error(": error: ");
    if (error.kind == headers::Error::Lexical) io::write_error(lexer::error_message(error.lexical));
    else io::write_error(headers::error_message(error.kind));
    io::write_error("\n");
    return 65;
}
