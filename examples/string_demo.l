module examples.string_demo;

import examples.string_values::{Text, Message, checksum};

const Text payload = "\x14\x16\0";
const int size = payload.length;
static string current = payload;

int main() {
    Message saved = Message{current, payload[size - 1]};
    current = "";
    if (saved.text != payload || saved.tag != byte(0)) return 1;
    return checksum(saved.text) + current.length;
}
