import { Socket, createSocket, RemoteInfo } from "dgram";
import * as broadcastAddress from "broadcast-address";
import EventEmitter = require("events");
import * as nw from "./network";

const TCNET_BROADCAST_PORT = 60000;

type STORED_RESOLVE = (value?: nw.TCNetDataPacket | PromiseLike<nw.TCNetDataPacket> | undefined) => void;

export class TCNetConfiguration {
    unicastPort = 65032;
    applicationCode = 0xffff;
    nodeId = Math.floor(Math.random() * 0xffff);
    nodeName = "TCNET.JS";
    vendorName = "CHDXD1";
    appName = "NODE-TCNET";
    broadcastInterface: string | null = null;
    broadcastAddress = "255.255.255.255";
    requestTimeout = 2000;
    debug = false;
}

/**
 * Low level implementation of the TCNet protocol
 */
export class TCNetClient extends EventEmitter {
    private config: TCNetConfiguration;
    private broadcastSocket: Socket;
    private unicastSocket: Socket;
    private server: RemoteInfo | null;
    private seq = 0;
    private uptime = 0;
    private requests: Map<string, STORED_RESOLVE> = new Map();
    private announcementInterval: NodeJS.Timeout;

    /**
     *
     * @param config configuration for TCNet access
     */
    constructor(config?: TCNetConfiguration) {
        super();
        this.config = config || new TCNetConfiguration();

        if (this.config.broadcastInterface && this.config.broadcastAddress == "255.255.255.255") {
            this.config.broadcastAddress = broadcastAddress(this.config.broadcastInterface);
        }
    }

    /**
     * Connect to the TCNet networks
     */
    public connect(): void {
        this.broadcastSocket = createSocket({ type: "udp4", reuseAddr: true }, this.receiveBroadcast.bind(this));
        this.broadcastSocket.bind(TCNET_BROADCAST_PORT, this.config.broadcastAddress, () =>
            this.broadcastSocket.setBroadcast(true),
        );

        this.unicastSocket = createSocket({ type: "udp4", reuseAddr: false }, this.receiveUnicast.bind(this));
        this.unicastSocket.bind(this.config.unicastPort, "0.0.0.0");

        this.announceApp();
        this.announcementInterval = setInterval(this.announceApp.bind(this), 1000);
    }

    /**
     * Disconnects from TCNet network
     */
    public disconnect(): void {
        clearInterval(this.announcementInterval);
        this.broadcastSocket.close();
        this.unicastSocket.close();
        this.removeAllListeners();
    }

    /**
     * Callback method to receive datagrams on the broadcast socket
     *
     * @param msg datagram buffer
     * @param rinfo remoteinfo
     */
    private receiveBroadcast(msg: Buffer, rinfo: RemoteInfo): void {
        const mgmtHeader = new nw.TCNetManagementHeader(msg);
        mgmtHeader.read();

        let packet: nw.TCNetPacket | null = null;

        if (mgmtHeader.messageType == nw.TCNetMessageType.OptIn) {
            packet = new nw.TCNetOptInPacket();
        } else if (mgmtHeader.messageType == nw.TCNetMessageType.Status) {
            packet = new nw.TCNetStatusPacket();
        } else if (mgmtHeader.messageType == nw.TCNetMessageType.OptOut) {
            packet = new nw.TCNetOptOutPacket();
        } else {
            if (this.config.debug) console.log("Unknown broadcast packet type: " + mgmtHeader.messageType);
        }

        if (packet) {
            packet.buffer = msg;
            packet.header = mgmtHeader;
            packet.read();

            // We received an OptIn packet from a server
            if (mgmtHeader.nodeType == nw.NodeType.Master) {
                if (packet instanceof nw.TCNetOptInPacket) {
                    if (this.config.debug) console.log("Received optin from current Master");
                    this.server = rinfo;
                    this.server.port = packet.nodeListenerPort;
                } else if (packet instanceof nw.TCNetOptOutPacket) {
                    if (this.config.debug) console.log("Received optout from current Master");
                    if (this.server?.address == rinfo.address && this.server?.port == packet.nodeListenerPort) {
                        this.server = null;
                    }
                }
            }

            this.emit("broadcast", packet);
        }
    }

    /**
     * Callback method to receive datagrams on the unicast socket
     *
     * @param msg datagram buffer
     * @param rinfo remoteinfo
     */
    private receiveUnicast(msg: Buffer, _rinfo: RemoteInfo): void {
        const mgmtHeader = new nw.TCNetManagementHeader(msg);
        mgmtHeader.read();

        if (mgmtHeader.messageType == nw.TCNetMessageType.Data) {
            const dataPacketHeader = new nw.TCNetDataPacket();
            dataPacketHeader.buffer = msg;
            dataPacketHeader.header = mgmtHeader;
            dataPacketHeader.read();

            let dataPacket: nw.TCNetDataPacket | null = null;

            if (dataPacketHeader.dataType == nw.TCNetDataPacketType.MetaData) {
                dataPacket = new nw.TCNetDataPacketMetadata();
            }

            if (dataPacket) {
                dataPacket.buffer = msg;
                dataPacket.header = mgmtHeader;
                dataPacket.dataType = dataPacketHeader.dataType;
                dataPacket.layer = dataPacketHeader.layer;
                dataPacket.read();

                const pendingRequest = this.requests.get(`${dataPacket.dataType}-${dataPacket.layer}`);
                if (pendingRequest) {
                    pendingRequest(dataPacket);
                }
            }
        } else {
            if (this.config.debug) console.log("Unknown packet type: " + mgmtHeader.messageType);
        }
    }

    /**
     * Fill headers of a packet
     *
     * @param packet Packet that needs header information
     */
    private fillHeader(packet: nw.TCNetPacket): void {
        packet.header = new nw.TCNetManagementHeader(packet.buffer);

        packet.header.minorVersion = 5;
        packet.header.nodeId = this.config.nodeId;
        packet.header.messageType = packet.type();
        packet.header.nodeName = this.config.nodeName;
        packet.header.seq = this.seq = (this.seq + 1) % 255;
        packet.header.nodeType = 0x04;
        packet.header.nodeOptions = 0;
        packet.header.timestamp = 0;
    }

    /**
     * Generalized method to send packets to a given destination on a given socket
     *
     * @param packet Packet to send
     * @param socket Socket to send on
     * @param port Destination Port
     * @param address Destination Address
     */
    private sendPacket(packet: nw.TCNetPacket, socket: Socket, port: number, address: string): Promise<void> {
        return new Promise((resolve, reject) => {
            const buffer = Buffer.alloc(packet.length());
            packet.buffer = buffer;
            this.fillHeader(packet);

            packet.header.write();
            packet.write();
            socket.send(buffer, port, address, (err) => {
                if (err) reject(err);
                resolve();
            });
        });
    }

    /**
     * Sends a packet to the discovered server
     * @param packet Packet to send
     */
    public async sendServer(packet: nw.TCNetPacket): Promise<void> {
        if (this.server === null) {
            throw new Error("Server not yet discovered");
        }

        await this.sendPacket(packet, this.unicastSocket, this.server.port, this.server.address);
    }

    /**
     * Called every second to announce our app on the network
     */
    private async announceApp(): Promise<void> {
        const optInPacket = new nw.TCNetOptInPacket();
        optInPacket.nodeCount = 0;
        optInPacket.nodeListenerPort = this.config.unicastPort;
        optInPacket.uptime = this.uptime++;

        // According to the guide the uptime shall roll over after 12 hours
        if (this.uptime >= 12 * 60 * 60) {
            this.uptime = 0;
        }

        optInPacket.vendorName = this.config.vendorName;
        optInPacket.appName = this.config.appName;
        optInPacket.majorVersion = 1;
        optInPacket.minorVersion = 1;
        optInPacket.bugVersion = 1;
        await this.broadcastPacket(optInPacket);
        if (this.server) {
            await this.sendServer(optInPacket);
        }
    }

    /**
     * Broadcasts a packet to the network
     *
     * @param packet packet to broadcast
     */
    public async broadcastPacket(packet: nw.TCNetPacket): Promise<void> {
        await this.sendPacket(packet, this.broadcastSocket, TCNET_BROADCAST_PORT, this.config.broadcastAddress);
    }

    /**
     * Sends a request packet to the discovered server
     *
     * @param dataType requested data type
     * @param layer requested layer
     * @returns Promise to wait for answer on request
     */
    public requestData(dataType: number, layer: number): Promise<nw.TCNetDataPacket> {
        return new Promise((resolve, reject) => {
            const request = new nw.TCNetRequestPacket();
            request.dataType = dataType;
            request.layer = layer;

            this.requests.set(`${dataType}-${layer}`, resolve);

            setTimeout(() => {
                if (this.requests.delete(`${dataType}-${layer}`)) {
                    reject(new Error("Timeout while requesting data"));
                }
            }, this.config.requestTimeout);

            this.sendServer(request);
        });
    }
}