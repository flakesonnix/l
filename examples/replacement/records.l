module app.records;

pub Pair = record { x: int; ready: bool; };
static int calls = 0;

int next() { calls++; return 40; }
Pair make() { return Pair { ready = calls == 0; x = next() + 2; }; }

int main() {
    Pair pair = make();
    Pair copy = pair;
    copy.x = 0;
    return if pair.ready && calls == 1 && copy.x == 0 then pair.x else 0;
}
