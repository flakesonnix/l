// Internal Stage 1 lexer. Uses only the existing Stage 0 subset.
module l.compiler.lexer;

pub const int capacity = 65535;

pub enum Kind {
    Invalid, End, Name, Integer, Text,
    Int, Bool, Void, Auto, Const, True, False, If, Else, While, For,
    Return, Module, Break, Continue, Switch, Case, Default, Import,
    As, Pub, Namespace, Static, Using, Struct, Enum, Byte, String, Extern,
    LeftBrace, RightBrace, LeftParen, RightParen, LeftBracket, RightBracket,
    Semicolon, Colon, Comma, Dot, Plus, Minus, Star, Slash, Percent,
    Bang, Less, Greater, Assign, Equal, NotEqual, LessEqual, GreaterEqual,
    And, Or, Increment, Decrement, Scope, Let, In, Var, Arrow, Then
};

pub enum Error {
    None, Nul, UnterminatedComment, UnterminatedString, UnterminatedEscape,
    HexEscape, UnsupportedEscape, NonPrintableString, IntegerRange,
    IntegerSuffix, UnsupportedCharacter
};

pub struct Token {
    Kind kind;
    int start;
    int length;
    int line;
    int column;
    // Nonpositive decimal magnitude; -2147483648 fits without a wider int.
    int magnitude;
    int text_length;
    Error error;
};

static byte source[capacity];
static byte decoded[capacity];
static int source_length = 0;
static int position = 0;
static int line = 1;
static int column = 1;
static bool sealed = false;
static int start = 0;
static int token_line = 1;
static int token_column = 1;
static int magnitude = 0;
static int text_length = 0;
static Error failure = Error::None;

// Replaying never reopens the input for appending.
pub void rewind() {
    position = 0;
    line = 1;
    column = 1;
    start = 0;
    token_line = 1;
    token_column = 1;
    magnitude = 0;
    text_length = 0;
    failure = Error::None;
}

pub void reset() {
    source_length = 0;
    sealed = false;
    rewind();
}

pub bool append(byte value) {
    if (sealed || source_length == capacity) return false;
    source[source_length] = value;
    source_length++;
    return true;
}

// -1 denotes an index outside the logical buffer, never a byte value.
pub int source_byte(int index) {
    if (index < 0 || index >= source_length) return -1;
    return int(source[index]);
}

// Decoded bytes belong to the most recently returned Text token only.
pub int text_byte(int index) {
    if (index < 0 || index >= text_length) return -1;
    return int(decoded[index]);
}

int peek(int distance) { return source_byte(position + distance); }

void advance() {
    if (source[position] == byte(10)) {
        line++;
        column = 1;
    } else column++;
    position++;
}

bool digit(int value) { return value >= 48 && value <= 57; }
bool alpha(int value) {
    return (value >= 65 && value <= 90) || (value >= 97 && value <= 122) || value == 95;
}

Token token(Kind kind) {
    return Token{kind, start, position - start, token_line, token_column,
                 magnitude, text_length, failure};
}

Token reject(Error error) {
    failure = error;
    magnitude = 0;
    text_length = 0;
    return token(Kind::Invalid);
}

bool word(string value) {
    if (position - start != value.length) return false;
    for (int index = 0; index < value.length; index++) {
        if (source[start + index] != value[index]) return false;
    }
    return true;
}

Kind keyword() {
    switch (int(source[start])) {
        case 97:
            if (word("auto")) return Kind::Auto;
            if (word("as")) return Kind::As;
            break;
        case 98:
            if (word("bool")) return Kind::Bool;
            if (word("break")) return Kind::Break;
            if (word("byte")) return Kind::Byte;
            break;
        case 99:
            if (word("const")) return Kind::Const;
            if (word("continue")) return Kind::Continue;
            if (word("case")) return Kind::Case;
            break;
        case 100: if (word("default")) return Kind::Default; break;
        case 101:
            if (word("else")) return Kind::Else;
            if (word("enum")) return Kind::Enum;
            if (word("extern")) return Kind::Extern;
            break;
        case 102:
            if (word("false")) return Kind::False;
            if (word("for")) return Kind::For;
            break;
        case 105:
            if (word("int")) return Kind::Int;
            if (word("in")) return Kind::In;
            if (word("if")) return Kind::If;
            if (word("import")) return Kind::Import;
            break;
        case 108: if (word("let")) return Kind::Let; break;
        case 109: if (word("module")) return Kind::Module; break;
        case 110: if (word("namespace")) return Kind::Namespace; break;
        case 112: if (word("pub")) return Kind::Pub; break;
        case 114: if (word("return")) return Kind::Return; break;
        case 115:
            if (word("switch")) return Kind::Switch;
            if (word("static")) return Kind::Static;
            if (word("struct")) return Kind::Struct;
            if (word("string")) return Kind::String;
            break;
        case 116:
            if (word("true")) return Kind::True;
            if (word("then")) return Kind::Then;
            break;
        case 117: if (word("using")) return Kind::Using; break;
        case 118:
            if (word("void")) return Kind::Void;
            if (word("var")) return Kind::Var;
            break;
        case 119: if (word("while")) return Kind::While; break;
    }
    return Kind::Name;
}

int hex(int value) {
    if (digit(value)) return value - 48;
    if (value >= 65 && value <= 70) return value - 65 + 10;
    if (value >= 97 && value <= 102) return value - 97 + 10;
    return -1;
}

Token text() {
    advance();
    while (position < source_length) {
        int value = peek(0);
        advance();
        if (value == 34) return token(Kind::Text);
        if (value == 92) {
            if (position == source_length) return reject(Error::UnterminatedEscape);
            value = peek(0);
            advance();
            switch (value) {
                case 110: value = 10; break;
                case 114: value = 13; break;
                case 116: value = 9; break;
                case 48: value = 0; break;
                case 92: case 34: break;
                case 120: {
                    if (source_length - position < 2) return reject(Error::HexEscape);
                    int high = hex(peek(0));
                    advance();
                    if (high < 0) return reject(Error::HexEscape);
                    int low = hex(peek(0));
                    advance();
                    if (low < 0) return reject(Error::HexEscape);
                    value = high * 16 + low;
                    break;
                }
                default: return reject(Error::UnsupportedEscape);
            }
        } else if (value < 32 || value > 126) return reject(Error::NonPrintableString);
        decoded[text_length] = byte(value);
        text_length++;
    }
    return reject(Error::UnterminatedString);
}

Kind pair(int first, int second) {
    if (first == 61) {
        if (second == 61) return Kind::Equal;
        if (second == 62) return Kind::Arrow;
        return Kind::Invalid;
    }
    if (first == 33 && second == 61) return Kind::NotEqual;
    if (first == 60 && second == 61) return Kind::LessEqual;
    if (first == 62 && second == 61) return Kind::GreaterEqual;
    if (first == 38 && second == 38) return Kind::And;
    if (first == 124 && second == 124) return Kind::Or;
    if (first == 43 && second == 43) return Kind::Increment;
    if (first == 45 && second == 45) return Kind::Decrement;
    if (first == 58 && second == 58) return Kind::Scope;
    return Kind::Invalid;
}

Kind single(int value) {
    switch (value) {
        case 123: return Kind::LeftBrace;
        case 125: return Kind::RightBrace;
        case 40: return Kind::LeftParen;
        case 41: return Kind::RightParen;
        case 91: return Kind::LeftBracket;
        case 93: return Kind::RightBracket;
        case 59: return Kind::Semicolon;
        case 58: return Kind::Colon;
        case 44: return Kind::Comma;
        case 46: return Kind::Dot;
        case 43: return Kind::Plus;
        case 45: return Kind::Minus;
        case 42: return Kind::Star;
        case 47: return Kind::Slash;
        case 37: return Kind::Percent;
        case 33: return Kind::Bang;
        case 60: return Kind::Less;
        case 62: return Kind::Greater;
        case 61: return Kind::Assign;
    }
    return Kind::Invalid;
}

pub Token next() {
    sealed = true;
    if (failure != Error::None) return token(Kind::Invalid);
    magnitude = 0;
    text_length = 0;
    while (true) {
        start = position;
        token_line = line;
        token_column = column;
        if (position == source_length) return token(Kind::End);
        int value = peek(0);
        if (value == 32 || value == 9 || value == 13 || value == 10) {
            advance();
            continue;
        }
        if (value == 47 && peek(1) == 47) {
            while (position < source_length && peek(0) != 10) {
                int current = peek(0);
                advance();
                if (current == 0) return reject(Error::Nul);
            }
            continue;
        }
        if (value == 47 && peek(1) == 42) {
            advance();
            advance();
            bool closed = false;
            while (position < source_length) {
                if (peek(0) == 42 && peek(1) == 47) {
                    advance();
                    advance();
                    closed = true;
                    break;
                }
                int current = peek(0);
                advance();
                if (current == 0) return reject(Error::Nul);
            }
            if (!closed) return reject(Error::UnterminatedComment);
            continue;
        }
        break;
    }
    int value = peek(0);
    if (value == 34) return text();
    if (alpha(value)) {
        advance();
        while (alpha(peek(0)) || digit(peek(0))) advance();
        return token(keyword());
    }
    if (digit(value)) {
        while (digit(peek(0))) {
            int unit = peek(0) - 48;
            advance();
            if (magnitude < -214748364 || (magnitude == -214748364 && unit > 8)) {
                return reject(Error::IntegerRange);
            }
            magnitude = magnitude * 10 - unit;
        }
        if (alpha(peek(0))) return reject(Error::IntegerSuffix);
        return token(Kind::Integer);
    }
    Kind kind = pair(value, peek(1));
    if (kind != Kind::Invalid) {
        advance();
        advance();
        return token(kind);
    }
    advance();
    if (value == 0) return reject(Error::Nul);
    kind = single(value);
    if (kind == Kind::Invalid) return reject(Error::UnsupportedCharacter);
    return token(kind);
}

pub string error_message(Error error) {
    switch (error) {
        case Error::None: return "no lexer error";
        case Error::Nul: return "NUL byte in source";
        case Error::UnterminatedComment: return "unterminated block comment";
        case Error::UnterminatedString: return "unterminated string literal";
        case Error::UnterminatedEscape: return "unterminated string escape";
        case Error::HexEscape: return "string hex escape requires two hexadecimal digits";
        case Error::UnsupportedEscape: return "unsupported string escape";
        case Error::NonPrintableString: return "string literals require printable ASCII or byte escapes";
        case Error::IntegerRange: return "integer literal exceeds int range";
        case Error::IntegerSuffix: return "invalid integer literal";
        case Error::UnsupportedCharacter: return "unsupported character in Stage 0 source";
        default: return "unknown lexer error";
    }
}
