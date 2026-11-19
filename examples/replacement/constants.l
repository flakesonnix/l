module app.constants;

pub answer: int = base + 2;
base: int = 40;
ready: bool = answer == 42;

int main() {
    return if ready then (let bonus = 0; in answer + bonus) else 0;
}
