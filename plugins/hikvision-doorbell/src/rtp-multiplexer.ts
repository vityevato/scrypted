import { EventEmitter } from 'events';
import dgram from 'dgram';
import { udpSocketType } from './utils';

/**
 * RTP Multiplexer
 * Receives RTP packets from single source and multicasts to multiple targets
 * Supports both IPv4 and IPv6
 */
export class RtpMultiplexer extends EventEmitter 
{
    private targets: Map<string, { ip: string; port: number; socket: dgram.Socket }> = new Map();
    private packetCount: number = 0;

    constructor (private console: Console) {
        super();
    }

    /**
     * Add target for RTP multicast
     */
    addTarget(id: string, ip: string, port: number): void {
        if (this.targets.has(id)) {
            this.console.warn(`Target ${id} already exists, replacing`);
            this.removeTarget(id);
        }

        const socketType = udpSocketType (ip);
        const socket = dgram.createSocket (socketType);
        socket.on('error', (err) => {
            this.console.error(`Socket error for target ${id}:`, err);
            this.removeTarget(id);
        });

        this.targets.set(id, { ip, port, socket });
        this.console.info(`Added RTP target ${id}: ${ip}:${port} (${socketType})`);
    }

    /**
     * Remove target
     */
    removeTarget(id: string): void {
        const target = this.targets.get(id);
        if (target) {
            try {
                target.socket.close();
            } catch (e) {
                // Ignore
            }
            this.targets.delete(id);
            this.console.info(`Removed RTP target ${id}`);
        }
    }

    /**
     * Send RTP packet to all targets
     */
    sendRtp(rtp: Buffer): void {
        this.packetCount++;

        if (this.targets.size === 0) {
            // No targets, skip
            return;
        }

        for (const [id, target] of this.targets.entries()) {
            try {
                target.socket.send(rtp, target.port, target.ip, (err) => {
                    if (err) {
                        this.console.error(`Failed to send RTP to ${id}:`, err);
                    }
                });
            } catch (error) {
                this.console.error(`Error sending RTP to ${id}:`, error);
            }
        }

        if (this.packetCount % 100 === 0) {
            this.console.debug(`Sent ${this.packetCount} RTP packets to ${this.targets.size} targets`);
        }
    }

    /**
     * Get current targets
     */
    getTargets(): string[] {
        return Array.from(this.targets.keys());
    }

    /**
     * Clear all targets and cleanup
     */
    destroy(): void {
        this.console.debug('Destroying multiplexer');
        for (const id of this.targets.keys()) {
            this.removeTarget(id);
        }
        this.removeAllListeners();
    }
}
