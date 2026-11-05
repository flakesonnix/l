module examples.string_values;

pub using Text = string;

pub struct Message {
    Text text;
    byte tag;
};

pub int checksum(Text text) {
    int sum = 0;
    for (int n = 0; n < text.length; n++) {
        sum = sum + int(text[n]);
    }
    return sum;
}
