// Internal expression syntax parser; no name resolution, typing or evaluation.
module l.compiler.expressions;

import l.compiler.lexer as lexer;

pub const int max_nodes = 2048;
pub const int max_depth = 48;

// Integer tags permit parallel scalar arrays in the existing Stage 0 subset.
namespace kind {
    pub const int Invalid = 0;
    pub const int Integer = 1;
    pub const int Bool = 2;
    pub const int Text = 3;
    pub const int Name = 4;
    pub const int Unary = 5;
    pub const int Binary = 6;
    pub const int Assign = 7;
    pub const int Call = 8;
    pub const int Struct = 9;
    pub const int Field = 10;
    pub const int Index = 11;
    pub const int Postfix = 12;
    pub const int Convert = 13;
}

namespace op {
    pub const int None = 0;
    pub const int Plus = 1;
    pub const int Minus = 2;
    pub const int Bang = 3;
    pub const int Star = 4;
    pub const int Slash = 5;
    pub const int Percent = 6;
    pub const int Less = 7;
    pub const int Greater = 8;
    pub const int LessEqual = 9;
    pub const int GreaterEqual = 10;
    pub const int Equal = 11;
    pub const int NotEqual = 12;
    pub const int And = 13;
    pub const int Or = 14;
    pub const int Assign = 15;
    pub const int Increment = 16;
    pub const int Decrement = 17;
    pub const int Int = 18;
    pub const int Byte = 19;
}

pub enum Error { None, Lexical, ExpectedExpression, ExpectedName, ExpectedOpen,
                 ExpectedClose, TrailingInput, TooDeep, TooManyNodes };
pub struct Diagnostic {
    Error kind;
    lexer::Error lexical;
    int start;
    int length;
    int line;
    int column;
};
pub struct Node {
    int kind;
    int op;
    int start;
    int length;
    int line;
    int column;
    // Negative magnitude for Integer; 0/1 for Bool; otherwise zero.
    int value;
    int text_length;
    int left;
    int right;
    int next;
};

static int kinds[max_nodes];
static int operations[max_nodes];
static int starts[max_nodes];
static int lengths[max_nodes];
static int lines[max_nodes];
static int columns[max_nodes];
static int values[max_nodes];
static int text_starts[max_nodes];
static int text_lengths[max_nodes];
static int lefts[max_nodes];
static int rights[max_nodes];
static int nexts[max_nodes];
static byte text[lexer::capacity];
static int used = 0;
static int text_used = 0;
static int depth = 0;

static lexer::Kind current_kind = lexer::Kind::End;
static lexer::Error current_error = lexer::Error::None;
static int current_start = 0;
static int current_length = 0;
static int current_line = 1;
static int current_column = 1;
static int current_magnitude = 0;
static int current_text_length = 0;
static Error failure = Error::None;
static lexer::Error lexical_failure = lexer::Error::None;
static int failure_start = 0;
static int failure_length = 0;
static int failure_line = 1;
static int failure_column = 1;

lexer::Token look() {
    return lexer::Token{current_kind, current_start, current_length, current_line,
                        current_column, current_magnitude, current_text_length, current_error};
}

void reject(Error error, lexer::Token at) {
    if (failure == Error::None) {
        failure = error;
        lexical_failure = at.error;
        failure_start = at.start;
        failure_length = at.length;
        failure_line = at.line;
        failure_column = at.column;
    }
}

void advance() {
    if (failure != Error::None) return;
    lexer::Token at = lexer::next();
    current_kind = at.kind;
    current_error = at.error;
    current_start = at.start;
    current_length = at.length;
    current_line = at.line;
    current_column = at.column;
    current_magnitude = at.magnitude;
    current_text_length = at.text_length;
    if (at.kind == lexer::Kind::Invalid) reject(Error::Lexical, at);
}

bool take(lexer::Kind expected) {
    if (failure != Error::None || current_kind != expected) return false;
    advance();
    return true;
}

void expect(lexer::Kind expected, Error error) {
    if (!take(expected)) reject(error, look());
}

int make_node(int kind, int operation, lexer::Token at, int left, int right) {
    if (failure != Error::None) return -1;
    if (used == max_nodes) {
        reject(Error::TooManyNodes, at);
        return -1;
    }
    int id = used++;
    kinds[id] = kind;
    operations[id] = operation;
    starts[id] = at.start;
    lengths[id] = at.length;
    lines[id] = at.line;
    columns[id] = at.column;
    values[id] = 0;
    text_starts[id] = 0;
    text_lengths[id] = 0;
    lefts[id] = left;
    rights[id] = right;
    nexts[id] = -1;
    return id;
}

int operation(lexer::Kind token) {
    switch (token) {
        case lexer::Kind::Plus: return op::Plus;
        case lexer::Kind::Minus: return op::Minus;
        case lexer::Kind::Bang: return op::Bang;
        case lexer::Kind::Star: return op::Star;
        case lexer::Kind::Slash: return op::Slash;
        case lexer::Kind::Percent: return op::Percent;
        case lexer::Kind::Less: return op::Less;
        case lexer::Kind::Greater: return op::Greater;
        case lexer::Kind::LessEqual: return op::LessEqual;
        case lexer::Kind::GreaterEqual: return op::GreaterEqual;
        case lexer::Kind::Equal: return op::Equal;
        case lexer::Kind::NotEqual: return op::NotEqual;
        case lexer::Kind::And: return op::And;
        case lexer::Kind::Or: return op::Or;
        case lexer::Kind::Assign: return op::Assign;
        case lexer::Kind::Increment: return op::Increment;
        case lexer::Kind::Decrement: return op::Decrement;
        case lexer::Kind::Int: return op::Int;
        case lexer::Kind::Byte: return op::Byte;
    }
    return op::None;
}

int precedence(lexer::Kind token) {
    switch (token) {
        case lexer::Kind::Assign: return 1;
        case lexer::Kind::Or: return 2;
        case lexer::Kind::And: return 3;
        case lexer::Kind::Equal: case lexer::Kind::NotEqual: return 4;
        case lexer::Kind::Less: case lexer::Kind::Greater:
        case lexer::Kind::LessEqual: case lexer::Kind::GreaterEqual: return 5;
        case lexer::Kind::Plus: case lexer::Kind::Minus: return 6;
        case lexer::Kind::Star: case lexer::Kind::Slash: case lexer::Kind::Percent: return 7;
    }
    return 0;
}

int arguments(lexer::Kind closing, bool trailing_comma) {
    int first = -1;
    int last = -1;
    if (!take(closing)) {
        while (failure == Error::None) {
            int argument = expression(1);
            if (failure != Error::None) break;
            if (last == -1) first = argument;
            else nexts[last] = argument;
            last = argument;
            if (!take(lexer::Kind::Comma)) break;
            if (trailing_comma && current_kind == closing) break;
        }
        expect(closing, Error::ExpectedClose);
    }
    return first;
}

// Read a type/name prefix without consuming a following declaration identifier.
pub int parse_name() {
    if (failure != Error::None) return -1;
    if (current_kind != lexer::Kind::Name) { reject(Error::ExpectedName, look()); return -1; }
    int result = make_node(kind::Name, op::None, look(), -1, -1);
    int last = result;
    advance();
    while (take(lexer::Kind::Scope)) {
        if (current_kind != lexer::Kind::Name) { reject(Error::ExpectedName, look()); break; }
        int part = make_node(kind::Name, op::None, look(), -1, -1);
        if (part == -1) break;
        rights[last] = part;
        last = part;
        advance();
    }
    if (failure != Error::None) return -1;
    return result;
}

int conversion(lexer::Token at) {
    expect(lexer::Kind::LeftParen, Error::ExpectedOpen);
    int value = expression(1);
    expect(lexer::Kind::RightParen, Error::ExpectedClose);
    return make_node(kind::Convert, operation(at.kind), at, value, -1);
}

int primary() {
    if (failure != Error::None) return -1;
    lexer::Token at = look();
    int result = -1;
    if (at.kind == lexer::Kind::Integer || at.kind == lexer::Kind::True || at.kind == lexer::Kind::False) {
        int tag = kind::Bool;
        if (at.kind == lexer::Kind::Integer) tag = kind::Integer;
        result = make_node(tag, op::None, at, -1, -1);
        if (result != -1) {
            values[result] = at.magnitude;
            if (at.kind == lexer::Kind::True) values[result] = 1;
        }
        advance();
    } else if (at.kind == lexer::Kind::Text) {
        result = make_node(kind::Text, op::None, at, -1, -1);
        if (result != -1) {
            text_starts[result] = text_used;
            text_lengths[result] = at.text_length;
            // Total decoded bytes cannot exceed the bounded raw input length.
            for (int index = 0; index < at.text_length; index++) text[text_used++] = byte(lexer::text_byte(index));
        }
        advance();
    } else if (at.kind == lexer::Kind::Name) {
        result = parse_name();
    } else if (at.kind == lexer::Kind::Int || at.kind == lexer::Kind::Byte) {
        advance();
        result = conversion(at);
    } else if (take(lexer::Kind::LeftParen)) {
        result = expression(1);
        expect(lexer::Kind::RightParen, Error::ExpectedClose);
    } else if (at.kind == lexer::Kind::Plus || at.kind == lexer::Kind::Minus || at.kind == lexer::Kind::Bang) {
        advance();
        int value = expression(8);
        result = make_node(kind::Unary, operation(at.kind), at, value, -1);
    } else reject(Error::ExpectedExpression, at);

    return postfix(result);
}

int postfix(int result) {
    while (failure == Error::None) {
        lexer::Token at = look();
        if (take(lexer::Kind::LeftParen)) {
            int first = arguments(lexer::Kind::RightParen, false);
            result = make_node(kind::Call, op::None, at, result, first);
        } else if (take(lexer::Kind::LeftBrace)) {
            int first = arguments(lexer::Kind::RightBrace, true);
            result = make_node(kind::Struct, op::None, at, result, first);
        } else if (take(lexer::Kind::Dot)) {
            lexer::Token field = look();
            expect(lexer::Kind::Name, Error::ExpectedName);
            result = make_node(kind::Field, op::None, field, result, -1);
        } else if (take(lexer::Kind::LeftBracket)) {
            int index = expression(1);
            expect(lexer::Kind::RightBracket, Error::ExpectedClose);
            result = make_node(kind::Index, op::None, at, result, index);
        } else if (at.kind == lexer::Kind::Increment || at.kind == lexer::Kind::Decrement) {
            advance();
            result = make_node(kind::Postfix, operation(at.kind), at, result, -1);
        } else break;
    }
    return result;
}

bool enter_at(lexer::Token at) {
    if (failure != Error::None) return false;
    if (depth == max_depth) { reject(Error::TooDeep, at); return false; }
    depth++;
    return true;
}
// Balanced by the statement parser too, so mixed syntax shares one depth budget.
pub bool enter() { return enter_at(look()); }
pub void leave() { depth--; }

int continuation(int left, int minimum) {
    while (failure == Error::None && precedence(current_kind) >= minimum) {
        lexer::Token at = look();
        int level = precedence(at.kind);
        int tag = kind::Binary;
        int next = level + 1;
        if (at.kind == lexer::Kind::Assign) { tag = kind::Assign; next = level; }
        advance();
        int right = expression(next);
        left = make_node(tag, operation(at.kind), at, left, right);
    }
    return left;
}

int expression(int minimum) {
    if (!enter()) return -1;
    int left = primary();
    left = continuation(left, minimum);
    leave();
    return left;
}

// Resume a disambiguated prefix, retaining the original depth-error location.
pub int parse_from_name(int id, lexer::Token at) {
    if (!enter_at(at)) return -1;
    if (id < 0 || id >= used || kinds[id] != kind::Name) reject(Error::ExpectedName, at);
    int result = postfix(id);
    result = continuation(result, 1);
    leave();
    if (failure != Error::None) return -1;
    return result;
}

pub int parse_from_conversion(lexer::Token at) {
    if (!enter_at(at)) return -1;
    if (at.kind != lexer::Kind::Int && at.kind != lexer::Kind::Byte) reject(Error::ExpectedExpression, at);
    int result = conversion(at);
    result = postfix(result);
    result = continuation(result, 1);
    leave();
    if (failure != Error::None) return -1;
    return result;
}

// Internal streaming entry points used by larger syntax parsers.
pub void begin() {
    used = 0;
    text_used = 0;
    depth = 0;
    failure = Error::None;
    lexical_failure = lexer::Error::None;
    failure_start = 0;
    failure_length = 0;
    failure_line = 1;
    failure_column = 1;
    lexer::rewind();
    advance();
}
pub lexer::Token current() { return look(); }
pub bool consume(lexer::Kind kind) { return take(kind); }
pub int parse_next() { return expression(1); }
pub void discard() { used = 0; text_used = 0; }

// Parse exactly one expression from the lexer's current source, replaying it.
pub int parse() {
    begin();
    int root = parse_next();
    if (failure == Error::None && current_kind != lexer::Kind::End) reject(Error::TrailingInput, look());
    if (failure != Error::None) { discard(); return -1; }
    return root;
}

pub int node_count() { return used; }
pub Node node(int id) {
    if (id < 0 || id >= used) return Node{kind::Invalid, op::None, 0, 0, 0, 0, 0, 0, -1, -1, -1};
    return Node{kinds[id], operations[id], starts[id], lengths[id], lines[id], columns[id],
                values[id], text_lengths[id], lefts[id], rights[id], nexts[id]};
}
pub int text_byte(int id, int index) {
    if (id < 0 || id >= used || index < 0 || index >= text_lengths[id]) return -1;
    return int(text[text_starts[id] + index]);
}
pub Diagnostic diagnostic() {
    return Diagnostic{failure, lexical_failure, failure_start, failure_length, failure_line, failure_column};
}
pub string error_message(Error error) {
    switch (error) {
        case Error::None: return "no expression error";
        case Error::Lexical: return "lexical error";
        case Error::ExpectedExpression: return "expected expression";
        case Error::ExpectedName: return "expected identifier";
        case Error::ExpectedOpen: return "expected '(' after conversion type";
        case Error::ExpectedClose: return "expected closing delimiter";
        case Error::TrailingInput: return "unexpected token after expression";
        case Error::TooDeep: return "expression nesting exceeds 48";
        case Error::TooManyNodes: return "expression exceeds 2048 AST nodes";
        default: return "unknown expression error";
    }
}
