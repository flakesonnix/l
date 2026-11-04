module examples.token_kinds;

pub enum Kind {
    Identifier,
    Number = 7,
    End,
};

pub struct Token {
    Kind kind;
    int value;
};

pub int evaluate(Token token) {
    switch (token.kind) {
        case Kind::Number: return token.value;
        default: return 0;
    }
}
