#include "../bootstrap/stage0/l.h"

#include <stdlib.h>
#include <string.h>

static int check(const char *source, bool valid) {
    Context *ctx = calloc(1, sizeof(*ctx));
    if (!ctx) exit(1);
    ctx->filename = "frontend-test.l";
    if (!setjmp(ctx->failure)) {
        size_t count;
        Token *tokens = lex(ctx, source, strlen(source), &count);
        analyze(ctx, parse(ctx, tokens, count));
    }
    bool accepted = ctx->status == 0;
    cleanup(ctx);
    free(ctx);
    if (accepted == valid) return 0;
    fprintf(stderr, "unexpected %s: %s\n", accepted ? "acceptance" : "rejection", source);
    return 1;
}

int main(void) {
    static const struct { const char *source; bool valid; } cases[] = {
        {"int main() { return 0; }", true},
        {"module app.main; /* comment */ int main(){ auto n=40; const int m=2; return n+m; }", true},
        {"int main(){return add(20,22);} int add(int a,int b){return a+b;}", true},
        {"bool positive(int a){return a>0;} int main(){if(positive(1))return 42;else return 0;}", true},
        {"int main(){int n=0;for(int i=0;i<7;i++){n=n+i;}while(n<42)n++;return n;}", true},
        {"void f(){return;} int main(){f();return 0;}", true},
        {"int main(){int n=1;{int n=2;n++;}return n;}", true},
        {"int main(){return -2147483648;}", true},
        {"int main(){bool b=true&&false||!false; if(b)return 1;return 0;}", true},
        {"int main(){return 2147483648;}", false},
        {"int main(){return 999999999999999999999999999;}", false},
        {"int main(){return true;}", false},
        {"int main(){int n;return n;}", false},
        {"int main(){const int n=1;n++;return n;}", false},
        {"int main(){const int n=1;n=2;return n;}", false},
        {"int main(){auto n=true;n=1;return 0;}", false},
        {"int main(){if(1)return 0;return 1;}", false},
        {"int main(){if(true)return 0;}", false},
        {"int main(){return missing;}", false},
        {"int main(){return missing();}", false},
        {"int f(int n){return n;}int main(){return f();}", false},
        {"int f(bool n){return 0;}int main(){return f(1);}", false},
        {"int main(){int x=0;int x=1;return x;}", false},
        {"int f(int n){int n=0;return n;}int main(){return 0;}", false},
        {"int main(){for(int i=0;i<1;i++){}return i;}", false},
        {"int main(){if(true)int n=1;return n;}", false},
        {"int main(){auto n=n;return n;}", false},
        {"int main(){return true+false;}", false},
        {"void f(){}int main(){auto n=f();return 0;}", false},
        {"void f(){}int main(){return f()==f();}", false},
        {"int main(){int f=1;return f();}", false},
        {"int main(){return 0;}int main(){return 1;}", false},
        {"int main(int argc){return argc;}", false},
        {"void main(){}", false},
        {"auto main(){return 0;}", false},
        {"int f(void n){return 0;}int main(){return 0;}", false},
        {"int f(){return 0;}", false},
        {"int main(){return 0", false},
        {"int main(){/* unterminated", false},
        {"int main(){return 42oops;}", false},
        {"int main(){return @;}", false},
        {"import std.io; int main(){return 0;}", false},
        {"int main(){void n=1;return 0;}", false},
        {"int main(){int n=1;return -n;}", true},
        {"int main(){return (true+);}", false},
        {"int main(){", false},
        {"int main();", false},
        {"int main(){1=2;return 0;}", false},
        {"int main(){missing=2;return 0;}", false},
        {"int main(){return 1==true;}", false},
        {"int main(){return (1+2)();}", false},
        {"int f(){return 0;}int main(){return f(1);}", false},
        {"int f(auto n){return 0;}int main(){return 0;}", false},
        {"int main(){{return 0;int n=1;}int m=2;return m;}", true},
        {"int MAIN_2(){return 0;} int main(){return MAIN_2();}", true},
        {"\t\r\n// comment\nint main(){/*a\nb*c/d*/return 0;}// tail", true},
        {"int main(){return 0;} /", false},
        {"int main(){return 0;} &x", false},
        {"int main(){return 0;} |x", false},
        {"int main(){return 0;} x", false},
        {"int main(){int a[3];a[1]=42;return a[1];}", true},
        {"int main(){bool a[1];a[0]=true;if(a[0])return 1;return 0;}", true},
        {"int main(){const int a[1];return a[0];}", true},
        {"int main(){int a[65535];int b[1];return a[65534]+b[0];}", true},
        {"int main(){int a[65535];int b[2];return 0;}", false},
        {"int main(){int a[0];return 0;}", false},
        {"int main(){int a[65536];return 0;}", false},
        {"int main(){int a[-1];return 0;}", false},
        {"int main(){int a[];return 0;}", false},
        {"int main(){int n=3;int a[n];return 0;}", false},
        {"int main(){int a[3;return 0;}", false},
        {"int main(){int a[3] return 0;}", false},
        {"int f(int a[1]){return 0;}int main(){return 0;}", false},
        {"int main(){int a[1]={1};return 0;}", false},
        {"int main(){auto a[1];return 0;}", false},
        {"int main(){void a[1];return 0;}", false},
        {"int main(){int a=1;return a[0];}", false},
        {"int main(){return missing[0];}", false},
        {"int main(){int a[1];return a[false];}", false},
        {"int main(){int a[1];return a[0;}", false},
        {"int main(){int a[1];return a[0][0];}", false},
        {"int main(){int a[1];return a;}", false},
        {"int main(){int a[1];a=0;return 0;}", false},
        {"int main(){int a[1];a[0]=true;return 0;}", false},
        {"int main(){const int a[1];a[0]=1;return 0;}", false},
        {"int main(){const int a[1];a[0]++;return 0;}", false},
        {"int main(){bool a[1];a[0]++;return 0;}", false},
        {"int main(){missing[0]=1;return 0;}", false},
        {"int main(){(1+2)[0]=1;return 0;}", false},
        {"int f(int n){return n;}int main(){int a[1];return f(a);}", false},
        {"int main(){while(true)break;return 0;}", true},
        {"int main(){while(false)continue;return 0;}", true},
        {"int main(){for(;;)break;return 0;}", true},
        {"int main(){for(int i=0;i<3;i++)continue;return 0;}", true},
        {"int main(){while(true){if(false)continue;else break;}return 0;}", true},
        {"int main(){for(;;){while(true)break;continue;}return 0;}", true},
        {"int main(){int breakfast=1;int continue_count=2;return breakfast+continue_count;}", true},
        {"int main(){break;return 0;}", false},
        {"int main(){continue;return 0;}", false},
        {"int main(){if(false)break;return 0;}", false},
        {"int main(){if(false)continue;return 0;}", false},
        {"int main(){while(false){}break;return 0;}", false},
        {"int main(){for(;;)break;continue;return 0;}", false},
        {"void f(){break;}int main(){while(true){f();break;}return 0;}", false},
        {"void f(){continue;}int main(){for(;;){f();break;}return 0;}", false},
        {"int main(){while(true){break}return 0;}", false},
        {"int main(){while(true){continue}return 0;}", false},
        {"int main(){for(;;){break 1;}return 0;}", false},
        {"int main(){for(;;){continue 1;}return 0;}", false},
        {"int main(){while(true){break;}}", false},
        {"int main(){for(;;){continue;}}", false},
        {"int main(){while(true){break;missing();}return 0;}", false},
        {"int main(){while(true){continue;int n=true;}return 0;}", false},
        {"int main(){for(;;true+1){break;}return 0;}", false}
    };
    int failures = 0;
    for (size_t i = 0; i < sizeof(cases) / sizeof(*cases); ++i) failures += check(cases[i].source, cases[i].valid);
    if (!failures) printf("frontend: %zu cases passed\n", sizeof(cases) / sizeof(*cases));
    return failures != 0;
}
