#!/bin/sh
set -eu
compiler=$(realpath "$1")
root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
mkdir -p "$root/build"
work=$(mktemp -d "$root/build/test.XXXXXX")
trap 'rm -f "$work"/*; rmdir "$work"' EXIT HUP INT TERM
count=0

status() {
    want_status=$1
    shift
    actual=0
    "$@" >"$work/stdout" 2>"$work/stderr" || actual=$?
    if [ "$actual" -ne "$want_status" ]; then
        cat "$work/stderr" >&2
        echo "FAIL: expected exit $want_status, got $actual: $*" >&2
        exit 1
    fi
    count=$((count + 1))
}

program() {
    program_status=$1
    source=$2
    printf '%s\n' "$source" >"$work/input.l"
    status 0 "$compiler" check "$work/input.l"
    status "$program_status" "$compiler" run "$work/input.l"
    if [ "$program_status" -eq 70 ]; then grep -q 'VM trap:' "$work/stderr"; fi
    status 0 "$compiler" compile "$work/input.l" -o "$work/first.lbc"
    status 0 "$compiler" check "$work/first.lbc"
    status "$program_status" "$compiler" run "$work/first.lbc"
    if [ "$program_status" -eq 70 ]; then grep -q 'VM trap:' "$work/stderr"; fi
    status 0 "$compiler" inspect "$work/input.l"
    cp "$work/stdout" "$work/source.ir"
    status 0 "$compiler" inspect "$work/first.lbc"
    cmp "$work/source.ir" "$work/stdout"
    status 0 "$compiler" compile "$work/input.l" -o "$work/second.lbc"
    cmp "$work/first.lbc" "$work/second.lbc"
}

program 42 'int main(){return 6*7;}'
program 55 'int fib(int n){if(n<2)return n;return fib(n-1)+fib(n-2);} int main(){return fib(10);}'
program 42 'int main(){int n=0;for(int i=0;i<7;i++){n=n+i;}while(n<42)n++;return n;}'
program 42 'int sum(int a,int b){return a+b;}int main(){return sum(sum(10,10),sum(10,12));}'
program 7 'int main(){int n=7;{int n=100;n++;}return n;}'
program 0 'int main(){int n=0;bool b=false&&((n=1)==1);bool c=true||((n=2)==2);return n;}'
program 2 'int main(){int n=0;bool b=true&&((n=1)==1);bool c=false||((n=2)==2);return n;}'
program 42 'void nop(){}void done(){return;} int main(){nop();done();auto n=40;n++;n++;return n;}'
program 42 'int main(){int x=0;int y=0;x=y=42;return +x;}'
program 1 'int main(){if(!false&&true!=false&&1==1&&1<=2&&2>=1&&2>1)return 1;else return 2;}'
program 42 'int main(){int n=43;int old=n--;if(old!=43)return 1;return n;}'
program 42 'int main(){for(;;){return 42;}return 0;}'
program 42 'int main(){int n=0;for(n=40;n<42;){n++;}return n;}'
program 42 'int main(){if(false){return 0;}else{int x=1;}return 42;}'
program 0 'int main(){return -2147483648%3+2;}'
program 0 'int main(){return 2147483647-2147483647;}'
program 0 'int main(){;return 7/2-3;}'
program 70 'int main(){return 2147483647+1;}'
program 70 'int main(){return -2147483648-1;}'
program 70 'int main(){return 100000*100000;}'
program 70 'int main(){return -(-2147483648);}'
program 70 'int main(){return 1/0;}'
program 70 'int main(){return 1%0;}'
program 70 'int main(){return -2147483648/-1;}'
program 70 'int main(){return -2147483648%-1;}'
program 70 'int recurse(){return recurse();}int main(){return recurse();}'
program 70 'int main(){while(true){}return 0;}'

status 42 "$compiler" run "$root/examples/answer.l"
status 55 "$compiler" run "$root/examples/fibonacci.l"
status 64 "$compiler"
status 64 "$compiler" unknown ignored
status 64 "$compiler" compile ignored
status 64 "$compiler" compile ignored --output ignored
status 64 "$compiler" compile ignored -o ignored
status 64 "$compiler" check ignored extra
status 74 "$compiler" check "$work/missing.l"
printf 'int main(){return true;}\n' >"$work/bad.l"
status 65 "$compiler" check "$work/bad.l"
grep -q ':1:12: error: expected int, got bool' "$work/stderr"
status 65 "$compiler" compile "$work/bad.l" -o "$work/invalid.lbc"
test ! -e "$work/invalid.lbc"
status 65 "$compiler" compile "$work/first.lbc" -o "$work/no.lbc"
status 74 "$compiler" compile "$root/examples/answer.l" -o "$work/missing/out.lbc"
status 74 "$compiler" compile "$root/examples/answer.l" -o /dev/full
printf 'nope' >"$work/bad.lbc"
status 65 "$compiler" run "$work/bad.lbc"
printf 'LBC\000\002\000\000\000' >"$work/bad.lbc"
status 65 "$compiler" run "$work/bad.lbc"
printf 'LBC\000' >"$work/bad.lbc"
status 65 "$compiler" run "$work/bad.lbc"

# The same declared source bytes at different absolute paths must produce identical artifacts.
cp "$root/examples/answer.l" "$work/relocated.l"
status 0 "$compiler" compile "$root/examples/answer.l" -o "$work/original.lbc"
status 0 "$compiler" compile "$work/relocated.l" -o "$work/relocated.lbc"
cmp "$work/original.lbc" "$work/relocated.lbc"
echo "integration: $count checks passed"
