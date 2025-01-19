import {
    TCNetClient,
    TCNetConfiguration,
    TCNetDataPacket,
    TCNetDataPacketMetadata,
    TCNetDataPacketMetrics,
    TCNetDataPacketType,
    TCNetLayerStatus,
    TCNetOptInPacket,
    TCNetPacket,
    TCNetStatusPacket,
} from "../src";

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

    type LayerInfo = {
        name: string | null;
        status: TCNetLayerStatus;
        trackID: number | null;
        pitchBend: number;
        speed: number;
    };

    const layerInfo: LayerInfo[] = new Array(8);

    for (let i = 0; i < 8; i++) {
        layerInfo[i] = {
            name: null,
            status: TCNetLayerStatus.IDLE,
            trackID: null,
            pitchBend: 0,
            speed: 0,
        };
    }

    const updateMetadataForLayer = (layer: number) => {
        const trackID = layerInfo[layer]?.trackID;
        if (typeof trackID !== "number") {
            return;
        }

        client
            .requestData(TCNetDataPacketType.MetaData, layer)
            .then((packet: TCNetDataPacket) => {
                if (packet instanceof TCNetDataPacketMetadata) {
                    console.log(packet);
                } else {
                    throw new Error("Unexpected packet type");
                }
            })
            .catch(() => {
                // Swallow error
            });
    };

    client.on("data", (packet: TCNetDataPacket) => {
        if (packet instanceof TCNetDataPacketMetrics) {
            // Correct for 1-based index
            const info = layerInfo[packet.layer - 1];
            if (info) {
                info.pitchBend = packet.data?.pitchBend ?? 0;
                info.speed = 1 + info.pitchBend / 10000;
            }
        }
    });

    client.on("broadcast", (packet: TCNetPacket) => {
        if (packet instanceof TCNetOptInPacket) {
            // Don't log these packets
            return;
        }
        if (packet instanceof TCNetStatusPacket) {
            for (let i = 0; i < packet.layers.length; i++) {
                const layer = packet.layers[i];
                const info = layerInfo[i];
                if (!info || !layer) {
                    throw new Error("Inconsistent layer indexes");
                }
                info.status = layer.status;
                info.name = layer.name;
                if (info.trackID !== layer.trackID) {
                    info.trackID = layer.trackID;
                    updateMetadataForLayer(i);
                }
            }
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
