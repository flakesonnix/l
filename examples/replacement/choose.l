module app.choose;

pub int choose(const bool ready) {
    return if ready then (let value = 40; in value + 2) else 1 / 0;
}

int main() {
    return choose(true);
}
