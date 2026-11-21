module app.aggregates;

Pair = record { value: int; ready: bool; };

Pair choose(bool ready) {
    return if ready
        then (let pair = Pair { ready = true; value = 42; }; in pair)
        else Pair { value = 1 / 0; ready = false; };
}

Pair changed(Pair original) {
    return let var copy = original;
               ignored = (copy.value = 0);
           in copy;
}

int main() {
    return let original = choose(true);
               copy = changed(original);
           in if original.ready && copy.value == 0 then original.value else 0;
}
