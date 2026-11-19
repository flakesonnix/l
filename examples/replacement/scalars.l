module app.scalars;

Kind = enum { Off; On; };
Octet = alias byte;
Text = alias string;
static int calls = 0;

Text choose(bool ready) {
    return if ready then (let tick = calls++; in "*") else "";
}

int main() {
    return let text: Text = choose(true);
               octet: Octet = if text == "*" then byte(42) else byte(256);
               kind: Kind = if calls == 1 then Kind::On else Kind::Off;
           in if kind == Kind::On then int(octet) else 0;
}
