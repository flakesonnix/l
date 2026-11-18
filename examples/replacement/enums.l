module app.enums;

pub Color = enum {
    Off;
    On = 42;
    Same = 42;
};

Color identity(const Color value) { return value; }

int main() {
    Color color = identity(Color::On);
    switch (color) {
        case Color::Same: return 42;
        default: return 0;
    }
}
