import EventEmitter = require('events');
import * as os from 'os';
import * as vscode from 'vscode';
import { ResettableTimeout, TerminalInputMode } from '../common';
import { BR_MAGENTA_FG, CSI, RESET } from './ansi-helpers';

const KEYS = {
    enter: '\r',
    del: '\x7f',
    bs: '\x08'
};
export interface IPtyTerminalOptions {
    name: string;       // Name of the terminal
    prompt: string;     // Prompt to be used
    inputMode: TerminalInputMode;
}

export function magentaWrite(msg: string, pty: PtyTerminal) {
    if (pty) {
        pty.write(BR_MAGENTA_FG + msg + RESET);
    }
}
const controlChars = {};
const zero = '@'.charCodeAt(0);
for (let ix = zero; ix <= 'Z'.charCodeAt(0); ix++) {
    controlChars[String.fromCharCode(ix)] = ix - zero;
}

class ACTIONS {
    public static cursorUp(n = 1)       { return n > 0 ? CSI + n.toString() + 'A' : ''; }
    public static cursorDown(n = 1)     { return n > 0 ? CSI + n.toString() + 'B' : ''; }
    public static cursorForward(n = 1)  { return n > 0 ? CSI + n.toString() + 'C' : ''; }
    public static cursorBack(n = 1)     { return n > 0 ? CSI + n.toString() + 'D' : ''; }
    public static clearAll()            { return CSI + '2J' + CSI + '3J' + CSI + ';H'; }  // Kill entire buffer and set cursor postion to 1,1
    public static clearScreen()         { return CSI + '2J' + CSI + ';H'; }               // Kill the visible part of the screen
    public static deleteChar()          { return CSI + 'P'; }
    public static deletePrevChar()      { return ACTIONS.cursorBack() + ACTIONS.deleteChar(); }
    public static deleteCurrChar()      { return ACTIONS.deleteChar(); }
    public static killLineForward()     { return CSI + 'K'; }
    public static killLine(n = 0)       { return ACTIONS.cursorBack(n) + ACTIONS.killLineForward(); }
    public static killEntireLine()      { return CSI + '2K'; }
}

/*
** The following events generated by this class
**
** emit('data', string)     -- user input data (value depends on inputmode)
** emit('close')            -- User killed the terminal. Terminal is not usable anymore
** emit('break')            -- User pressed Ctrl-C. COOKED mode only
** emit('eof')              -- User pressed Ctrl-D (POSIX) or Ctrl-Z (Windows) -- COOKED mode only
**
** 'eof' and 'break' does not mean any action was taken. It means the user presed those keys
** and it is upto the client to react.
**
** No event is generated when dispose() is called
*/
export class PtyTerminal extends EventEmitter {
    protected writeEmitter = new vscode.EventEmitter<string>();
    private didPrompt = false;
    private curLine = '';           // This input entered by the user
    private cursorPos = 1;          // This a relative position ater any prompt or output text
    public terminal: vscode.Terminal = null;
    private disposing = false;
    private isPaused = false;
    protected promptTimer: ResettableTimeout = null;
    public isReady = false;
    protected pendingWrites: any[] = [];
    private suspendPrompting: boolean = false;

    private static oldOnes: { [name: string]: PtyTerminal }  = {};

    private readonly pty: vscode.Pseudoterminal = {
        onDidWrite: this.writeEmitter.event,
        // onDidOverrideDimensions?: vscode.Event<vscode.TerminalDimensions>;
        // onDidClose?: vscode.Event<number | void>;
        open: () => { this.onOpen(); },
        close: () => { this.onClose(); },
        /*
        open(initialDimensions: vscode.TerminalDimensions): void {
            throw new Error('Method not implemented.');
        }
        */
        handleInput: (data: string) => { this.handleInput(data); }
        /*
        setDimensions?(dimensions: vscode.TerminalDimensions): void {
            throw new Error('Method not implemented.');
        }
        */
    };

    constructor(protected options: IPtyTerminalOptions) {
        super();
        this.terminal = vscode.window.createTerminal({
            name: this.options.name,
            pty: this.pty
        });
        this.resetOptions(options);
        PtyTerminal.oldOnes[this.options.name] = this;
        vscode.window.onDidCloseTerminal((t) => {
            if ((t === this.terminal) && !this.disposing) {
                this.onClose();
            }
        });
    }

    private onOpen() {
        this.isReady = true;
        if (this.pendingWrites.length) {
            for (const data of this.pendingWrites) {
                this.write(data);
            }
            this.pendingWrites = [];
        } else {
            this.doPrompt();
        }
    }

    private onClose() {
        this.emit('close');
        super.removeAllListeners();
        delete PtyTerminal.oldOnes[this.options.name];
        this.isReady = false;
        this.terminal = null;
    }

    public static findExisting(name: string): PtyTerminal  {
        return PtyTerminal.oldOnes[name];
    }

    // pause and resume are used when the terminal should appear to not take any input
    // all further input is lost. Output will still be processed
    public pause() {
        this.isPaused = true;
    }

    public resume() {
        this.isPaused = false;
    }

    public resetOptions(opts: IPtyTerminalOptions) {
        if (this.options.name !== opts.name) {
            throw Error('Reset terminal: Terminal name cannot change once created');
        }
        if (this.promptTimer) {
            this.promptTimer.kill();
            this.promptTimer = null;
        }
        this.unPrompt();        // This will clear any old prompt
        this.options = opts;
        this.curLine = '';
        this.cursorPos = 1;
        this.write('\n');       // This will write also prompt
    }

    protected handleInput(chars: string): void {
        if (this.isPaused || (this.options.inputMode === TerminalInputMode.DISABLED)) {
            return;
        }
        try {
            switch (chars) {
                case KEYS.enter:
                    this.handleReturn(chars);
                    break;
                case KEYS.del:
                    if (this.options.inputMode === TerminalInputMode.COOKED) {
                        this.killPrevChar();
                    } else {
                        this.emit('data', chars);
                    }
                    break;
                default:
                    if (!this.handleSpecialChars(chars)) {
                        // Handle special chars and leave the rest.
                        this.handleOtherChars(chars);
                    }
                    break;
            }
        }
        catch (e) {
            console.error(`MyPtyTerminal: handleInput: ${e}`);
        }
    }
    
    private handleReturn(chr: string) {
        if (this.options.inputMode === TerminalInputMode.COOKED) {
            this.emit('data', this.curLine + os.EOL);
        } else {
            this.emit('data', chr);
        }

        if (this.options.inputMode !== TerminalInputMode.RAW) {
            this.writeEmitter.fire('\r\n');
            this.cursorPos = 1;
            this.curLine = '';
            this.didPrompt = false;
            this.doPrompt();
        }
    }

    /*
    ** Most special chars are already handled. This function handles the rest. At this point
    ** We have keystrokes or a flood of characters from a Paste operation. This can get complicated
    ** as what is pasted can also have unprintable characters. We have a choice
    **
    ** 1. Reject the entire stream of chars
    ** 2. Filter the chars
    ** 3. Just pass it on to the program and let the string to Buffer translation deal. No loss of data
    **
    ** For now, we will go chose Option #3. This is far from perfect and we will revisit.
    **
    */
    private handleOtherChars(str: string) {
        // We are only expecting COOKED mode here. Everything else should have already been handled
        const lines = str.split(/\r\n|\r|\n/);
        if (lines.length > 1) {
            if (this.promptTimer) {
                this.promptTimer.kill();
                this.promptTimer = null;
            }
            // The last line decides if there will be a prompt or not. Otherwise, no prompt
            // emitted until all the lines are consumed
            this.didPrompt = false;
            this.suspendPrompting = true;
        }
        for (let ix = 0; ix < lines.length; ix++) {
            const line = lines[ix];
            const isLastLine = (ix === (lines.length - 1));
            if ((line === '') && isLastLine) {
                // Last line will be empty if the input string ended with a newline
                this.suspendPrompting = false;
                this.doPrompt();
                break;
            }
            let tail = this.curLine.slice(this.cursorPos - 1);
            this.curLine = PtyTerminal.insertCharsAt(this.curLine, line, this.cursorPos - 1);
            this.writeEmitter.fire(ACTIONS.killLineForward());
            if (!isLastLine) {
                this.writeEmitter.fire(line);
                this.cursorPos += line.length;
                this.curLine = (tail.length > 0) ? this.curLine.slice(0, -tail.length) : this.curLine;
                this.handleReturn(KEYS.enter);
                if (tail.length > 0) {
                    // We carry the tail with us to the next line but cursor position does not change
                    // Which at this point should be at the beginning of the next line.
                    this.writeEmitter.fire(tail + ACTIONS.cursorBack(tail.length));
                    this.curLine = tail;
                }
            } else {
                tail = this.curLine.slice(this.cursorPos - 1);
                this.writeEmitter.fire(tail);
                const count = tail.length - line.length;
                this.writeEmitter.fire(ACTIONS.cursorBack(count));
                this.cursorPos += line.length;
            }
        }
        this.suspendPrompting = false;
    }

    /*
    ** Handle character key sequences. Most terminals are variations of xterm which in turn
    ** are variations of a VT100. Here we are focussed only on termnial input and not what
    ** are supposed to be ouput ANSI sequences.
    **
    ** Handle commin CSI + Char codes
    ** Hanele (most) keys that are less than 0x20 (SPACE)
    **
    ** In the above, we ignore what we have not implemented but pretend that it has been handled
    ** Insterad of passing it on to the program as normal input. Example. we don't handle a TAB (yet)
    ** Neither do we handle Page Up/Down but they have a CSI prefix so again we ignore such things
    ** as they do not make sense for line editing.
    **
    ** See https://www.xfree86.org/current/ctlseqs.html
    **
    ** Note that Enter and Del have already been handled
    */
    protected handleSpecialChars(chars: string): boolean {
        if (this.options.inputMode !== TerminalInputMode.COOKED) {
            if (this.options.inputMode === TerminalInputMode.RAWECHO) {
                this.writeEmitter.fire(chars);
            }
            this.emit('data', chars);
            return true;
        }
        let code = chars.charCodeAt(0);
        if (code === 27) {      // Esc character
            if ((chars[1] !== '[') || (chars.length !== 3)) {
                // Function keys and some others fall into this category
                return false;
            }
            switch (chars[2]) {
                case 'A': { // UP: TODO: use for history
                    break;
                }
                case 'B': { // DOWN: TODO: use for history
                    break;
                }
                case 'C': { // RIGHT
                    this.moveRight();
                    break;
                }
                case 'D': { // LEFT
                    this.moveLeft();
                    break;
                }
                case 'H': { // Home
                    this.moveToBeg();
                    break;
                }
                case 'E': { // End
                    this.moveToEnd();
                    break;
                }
            }
            return true;
        } else if ((chars.length === 1) && (code < 0x20)) {
            chars = String.fromCharCode(code += 0x40);
            switch (chars) {
                case 'C': {
                    this.emit('break');
                    break;
                }
                case 'D': {
                    if (os.platform() !== 'win32') {
                        this.emit('eof');
                    }
                    break;
                }
                case 'Z': {
                    if (os.platform() === 'win32') {
                        this.emit('eof');
                    }
                    break;
                }
                case 'A': { // move cursor to beginning of line
                    this.moveToBeg();
                    break;
                }
                case 'E': { // move cursor to end of line
                    this.moveToEnd();
                    break;
                }
                case 'F': { // move cursor forward
                    this.moveRight();
                    break;
                }
                case 'B': { // move cursor back
                    this.moveLeft();
                    break;
                }
                case 'D': { // kill char at cursor
                    this.killCurrChar();
                    break;
                }
                case 'H': { // kill char left of cursor
                    this.killPrevChar();
                    break;
                }
                case 'K': { // Kill from current cursor (inclusive) to end of line
                    this.killLineFromCursor();
                    break;
                }
                case 'U': { // Kill entire line
                    this.killEntireLine();
                    break;
                }
                case 'L': {
                    this.clearScreen();
                    break;
                }
            }
            return true;
        } else {
            return false;
        }
    }

    private clearScreen() {
        this.writeEmitter.fire(ACTIONS.clearScreen());
        this.curLine = '';
        this.cursorPos = 1;
        this.didPrompt = false;
        this.doPrompt();
    }

    private killEntireLine() {
        const n = this.cursorPos - 1;
        this.writeEmitter.fire(ACTIONS.killLine(n));
        this.cursorPos = 1;
        this.curLine = '';
    }

    private killLineFromCursor() {
        const n = this.curLine.length - this.cursorPos + 1;
        if (n > 1) {
            this.writeEmitter.fire(ACTIONS.killLineForward());
            this.curLine = this.curLine.slice(this.cursorPos - 1, n);
        }
    }

    private killCurrChar() {
        if (this.cursorPos <= this.curLine.length) {
            this.writeEmitter.fire(ACTIONS.deleteCurrChar());
            this.curLine = PtyTerminal.removeCharAt(this.curLine, this.cursorPos - 1);
        }
    }

    private moveToEnd() {
        const n = this.curLine.length - this.cursorPos + 1;
        if (n > 0) {
            this.writeEmitter.fire(ACTIONS.cursorForward(n));
            this.cursorPos += n;
        }
    }

    private moveToBeg() {
        const n = this.cursorPos - 1;
        if (n > 0) {
            this.writeEmitter.fire(ACTIONS.cursorBack(n));
            this.cursorPos = 1;
        }
    }

    private moveLeft() {
        if (this.cursorPos > 1) {
            this.writeEmitter.fire(ACTIONS.cursorBack(1));
            this.cursorPos--;
        }
    }

    private moveRight() {
        if (this.cursorPos <= this.curLine.length) {
            this.writeEmitter.fire(ACTIONS.cursorForward(1));
            this.cursorPos++;
        }
    }

    private killPrevChar() {
        if (this.cursorPos > 1) {
            this.writeEmitter.fire(ACTIONS.deletePrevChar());
            this.cursorPos--;
            this.curLine = PtyTerminal.removeCharAt(this.curLine, this.cursorPos - 1);
        }
    }

    private static removeCharAt(str: string, ix: number): string {
        if (ix === 0) {
            return str.slice(1);
        } else if (ix >= (str.length - 1)) {
            return str.slice(0, -1);
        } else {
            return str.slice(0, ix) + str.slice(ix + 1);
        }
    }

    private static insertCharsAt(str: string, chr: string, ix: number): string {
        if (ix === 0) {
            return chr + str;
        } else if (ix >= str.length) {
            return str + chr;
        } else {
            return str.slice(0, ix) + chr + str.slice(ix);
        }
    }

    public clearTerminalBuffer() {
        this.writeEmitter.fire(ACTIONS.clearAll());
        this.curLine = '';
        this.cursorPos = 1;
    }

    public writeWithHeader(data: string | Buffer, header: string) {
        if (!this.terminal) {       // Writes after a terminal is closed
            return;
        }
        if (!header || !data) {
            this.write(data);
            return;
        }
        let str: string;
        if ((typeof data !== 'string') && !(data instanceof String)) {
            str = data.toString('utf8');
        } else {
            str = data as string;
        }
        if (this.cursorPos === 1) {
            this.write(header);
        }
        let endsWithNl = false;
        while (str.endsWith('\n')) {
            str = str.substr(0, str.length - 1);
            endsWithNl = true;
        }
        str = str.replace(/\n/g, '\n' + header);
        this.write(endsWithNl ? str + '\n' : str);
    }

    public write(data: string | Buffer) {
        if (!this.terminal) {       // Writes after a terminal is closed
            return;
        }
        if (!this.isReady) {
            this.pendingWrites.push(data);
            return;
        }
        try {
            this.unPrompt();
            if ((typeof data !== 'string') && !(data instanceof String)) {
                data = data.toString('utf8');
            }
            data = data.replace(/[\r]?\n/g, '\r\n');
            this.writeEmitter.fire(data);
            if (data.endsWith('\n')) {
                this.doPrompt();
            } else if (this.promptTimer) {
                this.promptTimer.kill();
            }
        }
        catch (e) {
            console.error(`MyPtyTerminal: write: ${e}`);
        }
    }

    // When we prompt, we not only write the prompt but also any remaining input
    protected doPrompt() {
        if (!this.didPrompt && !this.suspendPrompting) {
            if (this.promptTimer === null) {
                this.promptTimer = new ResettableTimeout(() => {
                const str = this.options.prompt + this.curLine;
                if (str.length) {
                    this.writeEmitter.fire(str);
                }
                this.cursorPos = this.curLine.length + 1;
                this.didPrompt = true;
                }, 100);
            } else {
                this.promptTimer.reset();
            }
        }
    }

    // When we unPrompt, we not only erase the prompt but any remaining input
    protected unPrompt() {
        if (this.didPrompt) {
            const len = this.options.prompt.length + this.cursorPos - 1;
            this.writeEmitter.fire(ACTIONS.killEntireLine());
            this.writeEmitter.fire(ACTIONS.cursorBack(len));
            this.writeEmitter.fire(this.curLine);
            this.didPrompt = false;
        }
    }

    public dispose() {
        if (this.terminal) {
            super.removeAllListeners();
            this.disposing = true;
            this.terminal.dispose();
            this.terminal = null;
            delete PtyTerminal.oldOnes[this.options.name];
        }
        if (this.promptTimer) {
            this.promptTimer.kill();
            this.promptTimer = null;
        }
    }
}
