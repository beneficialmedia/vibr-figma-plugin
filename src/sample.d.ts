// The development build adds a "Create Kiln cafe sample" command from a
// sample file that this repository leaves out. code.ts checks for it with
// typeof, so in this build the plugin always opens Send to Vibr.
declare const createKilnSample: undefined | (() => Promise<string>);
declare let kilnStage: string;
