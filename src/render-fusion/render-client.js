import {MQTTSignaling} from './signaling/mqtt-signaling';
import {WebRTCStatsLogger} from './webrtc-stats';
import {HybridRenderingUtils} from './utils';
import {ARENA_EVENTS} from '../constants';

const pcConfig = {
    'sdpSemantics': 'unified-plan',
    'bundlePolicy': 'balanced',
    'offerExtmapAllowMixed': false,
    'iceServers': [
        {'urls': 'stun:stun.l.google.com:19302'},
    ],
};

const sdpConstraints = {
    offerToReceiveAudio: 0,
    offerToReceiveVideo: 1,
    voiceActivityDetection: false,
};

const invalidCodecs = ['video/red', 'video/ulpfec', 'video/rtx'];
let preferredCodec = 'video/H264';
let preferredSdpFmtpPrefix = 'level-asymmetry-allowed=1;packetization-mode=1;';
let preferredSdpFmtpLine = 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f';

const dataChannelOptions = {
    ordered: true,
    // ordered: false, // do not guarantee order
    // maxPacketLifeTime: 17, // in milliseconds
    // maxRetransmits: null,
};

const supportsSetCodecPreferences = window.RTCRtpTransceiver &&
    'setCodecPreferences' in window.RTCRtpTransceiver.prototype;

AFRAME.registerComponent('arena-hybrid-render-client', {
    schema: {
        enabled: {type: 'boolean', default: false},
        position: {type: 'vec3', default: new THREE.Vector3()},
        rotation: {type: 'vec4', default: new THREE.Quaternion()},
        getStatsInterval: {type: 'number', default: 5000},
        ipd: {type: 'number', default: 0.064},
        hasDualCameras: {type: 'boolean', default: false},
        leftProj: {type: 'array'},
        rightProj: {type: 'array'},
    },

    init: async function() {
        this.initialized = false;
        ARENA.events.addMultiEventListener([
            ARENA_EVENTS.ARENA_LOADED,
            ARENA_EVENTS.MQTT_LOADED
        ], this.ready.bind(this));
    },
    ready: async function() {
        const data = this.data;
        const el = this.el;
        const sceneEl = el.sceneEl;

        this.arena = sceneEl.systems['arena-scene'];
        this.mqtt = sceneEl.systems['arena-mqtt'];

        console.info('[render-client] Starting...');
        this.connected = false;
        this.frameID = 0;

        this.compositor = sceneEl.systems['compositor'];

        this.id = this.arena.idTag;

        const host = this.mqtt.mqttHostURI;
        const username = this.mqtt.userName;
        const token = this.arena.mqttToken.mqtt_token;

        this.signaler = new MQTTSignaling(this.id, host, username, token);
        this.signaler.onOffer = this.gotOffer.bind(this);
        this.signaler.onHealthCheck = this.gotHealthCheck.bind(this);
        this.signaler.onAnswer = this.gotAnswer.bind(this);
        this.signaler.onIceCandidate = this.gotIceCandidate.bind(this);
        this.signaler.onConnect = this.connectToCloud.bind(this);
        window.onbeforeunload = () => {
            this.signaler.closeConnection();
        };

        await this.signaler.openConnection();

        window.addEventListener('enter-vr', this.onEnterVR.bind(this));
        window.addEventListener('exit-vr', this.onExitVR.bind(this));

        this.initialized = true;
    },

    connectToCloud: function() {
        const data = this.data;
        this.signaler.connectionId = null;

        console.debug('[render-client] connecting...');
        this.signaler.sendConnectACK();
    },

    onRemoteTrack: function(evt) {
        console.debug('got remote stream');

        const stream = new MediaStream();
        stream.addTrack(evt.track);

        // send remote track to compositor
        this.remoteVideo = document.getElementById('remoteVideo');
        if (!this.remoteVideo) {
            this.remoteVideo = document.createElement('video');
            this.remoteVideo.id = 'remoteVideo';
            this.remoteVideo.setAttribute('muted', 'false');
            this.remoteVideo.setAttribute('autoplay', 'true');
            this.remoteVideo.setAttribute('playsinline', 'true');
            this.remoteVideo.addEventListener('loadedmetadata', this.onRemoteVideoLoaded.bind(this), true);

            this.remoteVideo.style.position = 'absolute';
            this.remoteVideo.style.zIndex = '9999';
            this.remoteVideo.style.top = '15px';
            this.remoteVideo.style.left = '15px';
            this.remoteVideo.style.width = '384px';
            this.remoteVideo.style.height = '108px';
            if (!AFRAME.utils.device.isMobile()) {
                document.body.appendChild(this.remoteVideo);
            }

            /* const geometry = new THREE.PlaneGeometry(19.2, 10.8);
             * const material = new THREE.MeshBasicMaterial({ map: remoteRenderTarget.texture });
             * const mesh = new THREE.Mesh(geometry, material);
             * mesh.position.z = -12;
             * mesh.position.y = 7;
             * scene.add(mesh); */
        }
        // this.remoteVideo.style.display = 'block';
        this.remoteVideo.style.display = 'none';
        this.remoteVideo.srcObject = stream;
    },

    onRemoteVideoLoaded: function(evt) {
        const data = this.data;
        const el = this.el;

        const sceneEl = el.sceneEl;
        const renderer = sceneEl.renderer;

        // console.log('[render-client], remote video loaded!');
        const videoTexture = new THREE.VideoTexture(this.remoteVideo);
        videoTexture.minFilter = THREE.NearestFilter;
        videoTexture.magFilter = THREE.NearestFilter;
        videoTexture.colorSpace = THREE.SRGBColorSpace;
        const maxAnisotropy = renderer.capabilities.getMaxAnisotropy();
        videoTexture.anisotropy = maxAnisotropy;

        const remoteRenderTarget = new THREE.WebGLRenderTarget(this.remoteVideo.videoWidth, this.remoteVideo.videoHeight);
        remoteRenderTarget.texture = videoTexture;

        this.compositor.addRemoteRenderTarget(remoteRenderTarget);
        // this.compositor.bind();
    },

    onIceCandidate: function(event) {
        // console.log('pc ICE candidate: \n ' + event.candidate);
        if (event.candidate != null) {
            this.signaler.sendCandidate(event.candidate);
        }
    },

    setupTransceivers: function(isMac) {
        if (supportsSetCodecPreferences) {
            // Mac's H264 encoder produced colors that are a bit off, so prefer VP9
            if (isMac) {
                preferredCodec = 'video/VP9';
                preferredSdpFmtpPrefix = '';
                preferredSdpFmtpLine = 'profile-id=0';
            }

            const transceiver = this.pc.getTransceivers()[0];
            // const transceiver = this.pc.addTransceiver('video', {direction: 'recvonly'});
            const {codecs} = RTCRtpSender.getCapabilities('video');
            const validCodecs = codecs.filter((codec) => !invalidCodecs.includes(codec.mimeType));
            const preferredCodecs = validCodecs.sort(function(c1, c2) {
                if (c1.mimeType === preferredCodec && c1.sdpFmtpLine.includes(preferredSdpFmtpPrefix)) {
                    return -1;
                } else {
                    return 1;
                }
            });
            const selectedCodecIndex = validCodecs.findIndex((c) => c.mimeType === preferredCodec &&
                c.sdpFmtpLine === preferredSdpFmtpLine);
            if (selectedCodecIndex !== -1) {
                const selectedCodec = validCodecs[selectedCodecIndex];
                preferredCodecs.splice(selectedCodecIndex, 1);
                preferredCodecs.unshift(selectedCodec);
            }
            console.debug('[render-client] codecs', preferredCodecs);
            transceiver.setCodecPreferences(preferredCodecs);
        }
    },

    gotOffer: function(offer) {
        // console.log('got offer.');

        const _this = this;
        this.pc = new RTCPeerConnection(pcConfig);
        this.pc.onicecandidate = this.onIceCandidate.bind(this);
        this.pc.ontrack = this.onRemoteTrack.bind(this);
        this.pc.oniceconnectionstatechange = () => {
            if (_this.pc) {
                console.debug('[render-client] iceConnectionState changed:', this.pc.iceConnectionState);
                if (_this.pc.iceConnectionState === 'disconnected') {
                    _this.handleCloudDisconnect();
                }
            }
        };

        this.inputDataChannel = this.pc.createDataChannel('client-input', dataChannelOptions);
        this.inputDataChannel.onopen = () => {
            console.debug('[render-client] input data channel opened');
        };
        this.inputDataChannel.onclose = () => {
            console.debug('[render-client] input data channel closed');
            _this.handleCloudDisconnect();
        };

        this.statusDataChannel = this.pc.createDataChannel('client-status', dataChannelOptions);
        this.statusDataChannel.onopen = () => {
            console.debug('[render-client] status data channel opened');
        };
        this.statusDataChannel.onclose = () => {
            console.debug('[render-client] status data channel closed');
            _this.handleCloudDisconnect();
        };

        this.stats = new WebRTCStatsLogger(this.pc, this.signaler);

        this.pc.setRemoteDescription(new RTCSessionDescription(offer))
        .then(() => {
            this.createAnswer(offer.isMac);
        })
        .catch((err) => {
            console.error(err);
        });
    },

    createOffer: function() {
        // console.log('creating offer.');

        this.pc.createOffer(sdpConstraints)
        .then((description) => {
            this.pc.setLocalDescription(description)
            .then(() => {
                // console.log('sending offer.');
                this.signaler.sendOffer(this.pc.localDescription);
            })
            .catch((err) => {
                console.error(err);
            });
        })
        .catch((err) =>{
            console.error(err);
        });
    },

    gotAnswer: function(answer) {
        // console.log('got answer.');

        this.pc.setRemoteDescription(new RTCSessionDescription(answer))
        .then(() => {
            this.connected = true;

            const env = document.getElementById('env');
            env.setAttribute('visible', false);
            const groundPlane = document.getElementById('groundPlane');
            groundPlane.setAttribute('visible', false);

            this.checkStats();
        })
        .catch((err) => {
            console.error(err);
        });
    },

    createAnswer: function(isMac) {
        // console.log('creating answer.');

        this.setupTransceivers(isMac);

        this.pc.createAnswer()
        .then((description) => {
            this.pc.setLocalDescription(description)
            .then(() => {
                console.debug('sending answer');
                this.signaler.sendAnswer(this.pc.localDescription);
                this.createOffer();
            });
        })
        .then(() => {
            const receivers = this.pc.getReceivers();
            for (const receiver of receivers) {
                receiver.playoutDelayHint = 0;
            }
        })
        .catch((err) => {
            console.error(err);
        });
    },

    gotIceCandidate: function(candidate) {
        // console.log('got ice.');
        if (this.connected) {
            this.pc.addIceCandidate(new RTCIceCandidate(candidate));
        }
    },

    gotHealthCheck: function() {
        this.signaler.sendHealthCheckAck();
    },

    handleCloudDisconnect: function() {
        if (!this.connected) return;

        const env = document.getElementById('env');
        env.setAttribute('visible', true);
        const groundPlane = document.getElementById('groundPlane');
        groundPlane.setAttribute('visible', true);

        // this.compositor.unbind();
        this.compositor.disable();
        this.remoteVideo.style.display = 'none';

        this.connected = false;
        this.inputDataChannel = null;
        this.statusDataChannel = null;
        this.pc = null;
        this.healthCounter = 0;
        this.connectToCloud();
    },

    checkStats: async function() {
        const data = this.data;
        while (this.connected) {
            this.stats.getStats({latency: this.compositor.latency});
            await this.sleep(data.getStatsInterval);
        }
    },

    sleep: function(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    },

    sendStatus: function() {
        const el = this.el;
        const data = this.data;
        const sceneEl = el.sceneEl;

        const isVRMode = sceneEl.is('vr-mode');
        const isARMode = sceneEl.is('ar-mode');
        const hasDualCameras = (isVRMode && !isARMode) || (data.hasDualCameras);
        this.statusDataChannel.send(JSON.stringify({
            isVRMode: true,
            isARMode: isARMode,
            hasDualCameras: hasDualCameras,
            ipd: data.ipd,
            leftProj: data.leftProj,
            rightProj: data.rightProj,
            ts: new Date().getTime(),
        }));
    },

    onEnterVR: function() {
        if (!this.connected) return;
        this.sendStatus();
    },

    onExitVR: function() {
        if (!this.connected) return;
        this.statusDataChannel.send(JSON.stringify({
            isVRMode: false,
            ts: new Date().getTime(),
        }));
    },

    update: function(oldData) {
        const el = this.el;
        const data = this.data;

        let updateStatus = false;

        if (oldData.ipd !== undefined && data.ipd !== oldData.ipd) {
            updateStatus = true;
        }

        if (oldData.hasDualCameras !== undefined && data.hasDualCameras !== oldData.hasDualCameras) {
            updateStatus = true;
        }

        if (oldData.leftProj !== undefined && !AFRAME.utils.deepEqual(data.leftProj, oldData.leftProj)) {
            updateStatus = true;
        }

        if (oldData.rightProj !== undefined && !AFRAME.utils.deepEqual(data.rightProj, oldData.rightProj)) {
            updateStatus = true;
        }

        if (updateStatus) this.sendStatus();
    },

    tick: function(t, dt) {
        if (!this.initialized) return;
        const data = this.data;
        const el = this.el;

        const sceneEl = el.sceneEl;
        const scene = sceneEl.object3D;
        const camera = sceneEl.camera;

        const renderer = sceneEl.renderer;

        const cameraVR = renderer.xr.getCamera();

        if (this.connected && this.inputDataChannel.readyState === 'open') {
            const camPose = new THREE.Matrix4();
            camPose.copy(camera.matrixWorld);

            const currPos = new THREE.Vector3();
            const currRot = new THREE.Quaternion();
            currPos.setFromMatrixPosition(camPose);
            currRot.setFromRotationMatrix(camPose);

            var changed = false;
            if (data.position.distanceTo(currPos) > 0.01) {
                data.position.copy(currPos);
                changed = true;
            }

            if (data.rotation.angleTo(currRot) > 0.01) {
                data.rotation.copy(currRot);
                changed = true;
            }

            if (t < 1000 && changed === false) return;

            const camMsg = HybridRenderingUtils.doublesToCamMsg(...camPose.elements, parseFloat(this.frameID));
            this.inputDataChannel.send(camMsg);

            if (renderer.xr.enabled === true && renderer.xr.isPresenting === true) {
                const camPoseL = new THREE.Matrix4();
                const camPoseR = new THREE.Matrix4();
                camPoseL.copy(cameraVR.cameras[0].matrixWorld);
                camPoseR.copy(cameraVR.cameras[1].matrixWorld);

                this.compositor.prevFrames[this.frameID] = {
                    pose: [camPoseL, camPoseR],
                    ts: performance.now(),
                };
            } else {
                this.compositor.prevFrames[this.frameID] = {
                    pose: camPose,
                    ts: performance.now(),
                };
            }

            this.frameID = (this.frameID + 100) & 0xFFFFFFFF;
        }
    },
});