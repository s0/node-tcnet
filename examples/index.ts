import { TCNetClient, TCNetConfiguration, TCNetDataPacket, TCNetOptInPacket, TCNetPacket } from "../src";

const INTERFACE = process.argv[2];

if (!INTERFACE) {
    console.error("INTERFACE is not set");
    process.exit(1);
}

console.log(`Connecting to TCNet on ${INTERFACE}`);

const config = new TCNetConfiguration();

config.broadcastInterface = INTERFACE;
config.brodcastListeningAddress = "0.0.0.0";

const client = new TCNetClient(config);

const run = async () => {
    await client.connect();
    console.log("Connected to TCNet");

    client.on("data", (packet: TCNetDataPacket) => {
        console.log("data", packet);
    });

    client.on("broadcast", (packet: TCNetPacket) => {
        if (packet instanceof TCNetOptInPacket) {
            // Don't log these packets
            return;
        }
        console.log("broadcast", packet);
    });
};

run();

process.on("SIGINT", async () => {
    console.log("Shutting down TCNet client");
    await client.disconnect();
    process.exit(0);
});
