// Function-only source-file syntax check; no resolution, typing or execution.
module l.compiler.function_main;

import l.compiler.lexer as lexer;
import l.compiler.expressions as expressions;
import l.compiler.statements as statements;
import l.compiler.headers as headers;
import l.compiler.functions as functions;
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
void expression_message(expressions::Error error, lexer::Error lexical) {
    if (error == expressions::Error::Lexical) io::write_error(lexer::error_message(lexical));
    else io::write_error(expressions::error_message(error));
}
int main() {
    lexer::reset();
    int value = io::read_byte();
    while (value != -1) {
        if (!lexer::append(byte(value))) {
            io::write_error("function: source exceeds 65535 bytes\n");
            return 65;
        }
        value = io::read_byte();
    }
    if (functions::parse() != -1) return 0;
    functions::Diagnostic error = functions::diagnostic();
    io::write_error("function:");
    write_number(error.line);
    io::write_error(":");
    write_number(error.column);
    io::write_error(": error: ");
    if (error.kind == functions::Error::Header) {
        if (error.header == headers::Error::Lexical) io::write_error(lexer::error_message(error.lexical));
        else io::write_error(headers::error_message(error.header));
    } else if (error.kind == functions::Error::Statement) {
        if (error.statement == statements::Error::Expression) expression_message(error.expression, error.lexical);
        else io::write_error(statements::error_message(error.statement));
    } else if (error.kind == functions::Error::Expression) expression_message(error.expression, error.lexical);
    else io::write_error(functions::error_message(error.kind));
    io::write_error("\n");
    return 65;
}
