module examples.state;

static int counter = 40;

namespace flags {
    pub static bool enabled = true;
}

pub int next() {
    return counter++;
}
