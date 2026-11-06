// Control-flow syntax only; declarations and semantic/context checks are absent.
module l.compiler.statements;

import l.compiler.lexer as lexer;
import l.compiler.expressions as expressions;

pub const int max_nodes = 1024;
namespace kind {
    pub const int Invalid = 0;
    pub const int Empty = 1;
    pub const int Expression = 2;
    pub const int Block = 3;
    pub const int If = 4;
    pub const int While = 5;
    pub const int For = 6;
    pub const int Return = 7;
    pub const int Break = 8;
    pub const int Continue = 9;
    pub const int Switch = 10;
    pub const int Case = 11;
    pub const int Default = 12;
}
pub enum Error { None, Expression, ExpectedOpen, ExpectedClose, ExpectedSemicolon,
                 ExpectedColon, ExpectedLabel, UnexpectedLabel, TrailingInput, TooDeep, TooManyNodes };
pub struct Diagnostic {
    Error kind;
    expressions::Error expression;
    lexer::Error lexical;
    int start;
    int length;
    int line;
    int column;
};
pub struct Node {
    int kind;
    int start;
    int length;
    int line;
    int column;
    int expression;
    int init;
    int condition;
    int step;
    int body;
    int other;
    int next;
};

static int kinds[max_nodes];
static int starts[max_nodes];
static int lengths[max_nodes];
static int lines[max_nodes];
static int columns[max_nodes];
static int values[max_nodes];
static int inits[max_nodes];
static int conditions[max_nodes];
static int steps[max_nodes];
static int bodies[max_nodes];
static int others[max_nodes];
static int nexts[max_nodes];
static int used = 0;
static Error failure = Error::None;
static expressions::Error expression_failure = expressions::Error::None;
static lexer::Error lexical_failure = lexer::Error::None;
static int failure_start = 0;
static int failure_length = 0;
static int failure_line = 1;
static int failure_column = 1;

void reject(Error error, lexer::Token at) {
    if (failure == Error::None) {
        failure = error;
        failure_start = at.start;
        failure_length = at.length;
        failure_line = at.line;
        failure_column = at.column;
    }
}

bool ok() {
    if (failure == Error::None) {
        expressions::Diagnostic error = expressions::diagnostic();
        if (error.kind != expressions::Error::None) {
            failure = Error::Expression;
            if (error.kind == expressions::Error::TooDeep) failure = Error::TooDeep;
            expression_failure = error.kind;
            lexical_failure = error.lexical;
            failure_start = error.start;
            failure_length = error.length;
            failure_line = error.line;
            failure_column = error.column;
        }
    }
    return failure == Error::None;
}

lexer::Token current() { return expressions::current(); }
bool at(lexer::Kind kind) { return current().kind == kind; }
bool take(lexer::Kind kind) {
    if (!ok()) return false;
    bool taken = expressions::consume(kind);
    ok();
    return taken;
}
void expect(lexer::Kind kind, Error error) {
    if (!take(kind) && ok()) reject(error, current());
}
int value() {
    if (!ok()) return -1;
    int result = expressions::parse_next();
    ok();
    return result;
}
int make_node(int kind, lexer::Token token) {
    if (!ok()) return -1;
    if (used == max_nodes) { reject(Error::TooManyNodes, token); return -1; }
    int id = used++;
    kinds[id] = kind;
    starts[id] = token.start;
    lengths[id] = token.length;
    lines[id] = token.line;
    columns[id] = token.column;
    values[id] = -1;
    inits[id] = -1;
    conditions[id] = -1;
    steps[id] = -1;
    bodies[id] = -1;
    others[id] = -1;
    nexts[id] = -1;
    return id;
}
int condition() {
    expect(lexer::Kind::LeftParen, Error::ExpectedOpen);
    int result = value();
    expect(lexer::Kind::RightParen, Error::ExpectedClose);
    return result;
}

int statement() {
    if (!ok()) return -1;
    if (!expressions::enter()) { ok(); return -1; }
    lexer::Token token = current();
    int result = -1;
    if (take(lexer::Kind::LeftBrace)) {
        result = make_node(kind::Block, token);
        int last = -1;
        while (ok() && !take(lexer::Kind::RightBrace)) {
            if (at(lexer::Kind::End)) { reject(Error::ExpectedClose, current()); break; }
            int child = statement();
            if (!ok()) break;
            if (last == -1) bodies[result] = child;
            else nexts[last] = child;
            last = child;
        }
    } else if (take(lexer::Kind::If)) {
        int test = condition();
        int yes = statement();
        int no = -1;
        if (take(lexer::Kind::Else)) no = statement();
        result = make_node(kind::If, token);
        if (result != -1) { conditions[result] = test; bodies[result] = yes; others[result] = no; }
    } else if (take(lexer::Kind::While)) {
        int test = condition();
        int body = statement();
        result = make_node(kind::While, token);
        if (result != -1) { conditions[result] = test; bodies[result] = body; }
    } else if (take(lexer::Kind::For)) {
        expect(lexer::Kind::LeftParen, Error::ExpectedOpen);
        int init = -1;
        int test = -1;
        int step = -1;
        if (!take(lexer::Kind::Semicolon)) { init = value(); expect(lexer::Kind::Semicolon, Error::ExpectedSemicolon); }
        if (!take(lexer::Kind::Semicolon)) { test = value(); expect(lexer::Kind::Semicolon, Error::ExpectedSemicolon); }
        if (!take(lexer::Kind::RightParen)) { step = value(); expect(lexer::Kind::RightParen, Error::ExpectedClose); }
        int body = statement();
        result = make_node(kind::For, token);
        if (result != -1) { inits[result] = init; conditions[result] = test; steps[result] = step; bodies[result] = body; }
    } else if (take(lexer::Kind::Return)) {
        int expression = -1;
        if (!take(lexer::Kind::Semicolon)) { expression = value(); expect(lexer::Kind::Semicolon, Error::ExpectedSemicolon); }
        result = make_node(kind::Return, token);
        if (result != -1) values[result] = expression;
    } else if (token.kind == lexer::Kind::Break || token.kind == lexer::Kind::Continue) {
        take(token.kind);
        expect(lexer::Kind::Semicolon, Error::ExpectedSemicolon);
        int tag = kind::Break;
        if (token.kind == lexer::Kind::Continue) tag = kind::Continue;
        result = make_node(tag, token);
    } else if (take(lexer::Kind::Switch)) {
        int selector = condition();
        expect(lexer::Kind::LeftBrace, Error::ExpectedOpen);
        result = make_node(kind::Switch, token);
        if (result != -1) values[result] = selector;
        int last_label = -1;
        while (ok() && !take(lexer::Kind::RightBrace)) {
            if (at(lexer::Kind::End)) { reject(Error::ExpectedClose, current()); break; }
            lexer::Token label_token = current();
            int tag = kind::Case;
            int label_value = -1;
            if (take(lexer::Kind::Case)) label_value = value();
            else if (take(lexer::Kind::Default)) tag = kind::Default;
            else { reject(Error::ExpectedLabel, current()); break; }
            expect(lexer::Kind::Colon, Error::ExpectedColon);
            int label = make_node(tag, label_token);
            if (!ok()) break;
            values[label] = label_value;
            if (last_label == -1) bodies[result] = label;
            else nexts[last_label] = label;
            last_label = label;
            int last = -1;
            while (ok() && !at(lexer::Kind::Case) && !at(lexer::Kind::Default) && !at(lexer::Kind::RightBrace)) {
                if (at(lexer::Kind::End)) { reject(Error::ExpectedClose, current()); break; }
                int child = statement();
                if (!ok()) break;
                if (last == -1) bodies[label] = child;
                else nexts[last] = child;
                last = child;
            }
        }
    } else if (token.kind == lexer::Kind::Case || token.kind == lexer::Kind::Default) reject(Error::UnexpectedLabel, token);
    else if (take(lexer::Kind::Semicolon)) result = make_node(kind::Empty, token);
    else {
        int expression = value();
        expect(lexer::Kind::Semicolon, Error::ExpectedSemicolon);
        result = make_node(kind::Expression, token);
        if (result != -1) values[result] = expression;
    }
    expressions::leave();
    return result;
}

pub int parse() {
    used = 0;
    failure = Error::None;
    expression_failure = expressions::Error::None;
    lexical_failure = lexer::Error::None;
    failure_start = 0;
    failure_length = 0;
    failure_line = 1;
    failure_column = 1;
    expressions::begin();
    int root = statement();
    if (ok() && !at(lexer::Kind::End)) reject(Error::TrailingInput, current());
    if (!ok()) { used = 0; expressions::discard(); return -1; }
    return root;
}
pub int node_count() { return used; }
pub Node node(int id) {
    if (id < 0 || id >= used) return Node{kind::Invalid, 0, 0, 0, 0, -1, -1, -1, -1, -1, -1, -1};
    return Node{kinds[id], starts[id], lengths[id], lines[id], columns[id], values[id],
                inits[id], conditions[id], steps[id], bodies[id], others[id], nexts[id]};
}
pub Diagnostic diagnostic() {
    return Diagnostic{failure, expression_failure, lexical_failure, failure_start, failure_length, failure_line, failure_column};
}
pub string error_message(Error error) {
    switch (error) {
        case Error::None: return "no statement error";
        case Error::Expression: return "expression error";
        case Error::ExpectedOpen: return "expected opening delimiter";
        case Error::ExpectedClose: return "expected closing delimiter";
        case Error::ExpectedSemicolon: return "expected ';' after statement";
        case Error::ExpectedColon: return "expected ':' after switch label";
        case Error::ExpectedLabel: return "expected case or default label";
        case Error::UnexpectedLabel: return "case/default requires an enclosing switch body";
        case Error::TrailingInput: return "unexpected token after statement";
        case Error::TooDeep: return "syntax nesting exceeds 48";
        case Error::TooManyNodes: return "statement exceeds 1024 AST nodes";
        default: return "unknown statement error";
    }
}
