﻿function Renderer(engine) {
    
    var self = this;
    var gl = null;

    this.viewportInfo = null;
    this.maxStandardMaterialLights = 5;
    this.maxSkinnedMeshBones = 30;

    this.renderingOptions = {
        renderLightVolumeForLightId: null,
        renderLightVolumes: false,
        renderWorldStaticMeshAABBs: false,
        renderActorBoundingSpheres: false
    };

    this.renderingParameters = {};

    this.shadowMapMasksForStaticObjectsByChannel = {
        0: [1.0, 0.0, 0.0, 0.0],
        1: [0.0, 0.0, 1.0, 0.0],
    }

    this.shadowMapMasksForDynamicObjectsByChannel = {
        0: [0.0, 1.0, 0.0, 0.0],
        1: [0.0, 0.0, 0.0, 1.0],
    }

    this.pointLightShadowMapFaces = null;

    this.shadowMapBuildBuffers = {
        backPassFrameBuffer: null,
        backPassBufferTexture: null,
        depthRenderBuffer: null
    }

    this.globalIlluminationNormals = [];
    this.globalIlluminationColours = null;

    this.init = function (callback) {

        gl = engine.glManager.gl;

        var initFunctions = [this.initSystemTextures, this.initPointLightShadowMapFaces, this.initShadowMapBuildBuffers, this.initGlobalIlluminationNormals];

        util.recurse(function (recursor, recursionCount) {
            if (recursionCount < initFunctions.length) {
                initFunctions[recursionCount](recursor);
            } else {
                callback();
            }
        });
    }

    this.initSystemTextures = function (callback) {

        self.log('Loading system textures...');

        var systemTextureIds = [
            'system/missing-diffuse-texture',
            'system/missing-normal-texture',
            'system/dummy-cube'
        ];

        engine.textureManager.loadTextures(systemTextureIds, function () {

            self.log('... done.');

            callback();
        });
    }

    this.initPointLightShadowMapFaces = function (callback) {

        self.pointLightShadowMapFaces = [
            { target: gl.TEXTURE_CUBE_MAP_POSITIVE_X, lookAt: [1.0, 0.0, 0.0], up: [0.0, -1.0, 0.0] },
            { target: gl.TEXTURE_CUBE_MAP_NEGATIVE_X, lookAt: [-1.0, 0.0, 0.0], up: [0.0, -1.0, 0.0] },
            { target: gl.TEXTURE_CUBE_MAP_POSITIVE_Y, lookAt: [0.0, 1.0, 0.0], up: [0.0, 0.0, 1.0] },
            { target: gl.TEXTURE_CUBE_MAP_NEGATIVE_Y, lookAt: [0.0, -1.0, 0.0], up: [0.0, 0.0, -1.0] },
            { target: gl.TEXTURE_CUBE_MAP_POSITIVE_Z, lookAt: [0.0, 0.0, 1.0], up: [0.0, -1.0, 0.0] },
            { target: gl.TEXTURE_CUBE_MAP_NEGATIVE_Z, lookAt: [0.0, 0.0, -1.0], up: [0.0, -1.0, 0.0] }
        ];

        callback();
    }

    this.initShadowMapBuildBuffers = function (callback) {

        var bufferSize = engine.shadowMapManager.bufferSize;

        // Init the back pass frame buffer.
        self.shadowMapBuildBuffers.backPassFrameBuffer = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, self.shadowMapBuildBuffers.backPassFrameBuffer);

        // Init the back pass buffer texture.
        self.shadowMapBuildBuffers.backPassBufferTexture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, self.shadowMapBuildBuffers.backPassBufferTexture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, bufferSize, bufferSize, 0, gl.RGBA, gl.FLOAT, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, self.shadowMapBuildBuffers.backPassBufferTexture, 0);

        // Create the depth render buffer.
        self.shadowMapBuildBuffers.depthRenderBuffer = gl.createRenderbuffer();
        gl.bindRenderbuffer(gl.RENDERBUFFER, self.shadowMapBuildBuffers.depthRenderBuffer);
        gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, bufferSize, bufferSize);
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, self.shadowMapBuildBuffers.depthRenderBuffer);
        gl.bindRenderbuffer(gl.RENDERBUFFER, null);

        callback();
    }

    this.initGlobalIlluminationNormals = function (callback) {

        var normals = [
            [-1.0, 1.0, 1.0], // Near, top, left.
            [1.0, 1.0, 1.0], // Near, top, right.
            [-1.0, -1.0, 1.0], // Near, bottom, left.
            [1.0, -1.0, 1.0], // Near, bottom, right.
            [-1.0, 1.0, -1.0], // Far, top, left.
            [1.0, 1.0, -1.0], // Far, top, right.
            [-1.0, -1.0, -1.0], // Far, bottom, left.
            [1.0, -1.0, -1.0], // Far, bottom, right.
        ];

        for (var i = 0; i < normals.length; i++) {
            var normal = normals[i];
            vec3.normalize(normal, normal);

            util.arrayPushMany(self.globalIlluminationNormals, normal);
        }

        callback();
    }

    this.renderScene = function () {
     
        this.globalIlluminationColours = [];
        for (var i = 0; i < engine.map.globalIlluminationColours.length; i++) {
            var colour = engine.map.globalIlluminationColours[i];
            util.arrayPushMany(this.globalIlluminationColours, colour);
        }

        var cameraViewProjMatrix = engine.camera.makeViewProjMatrix(
            Math.PI / 2.5, engine.glManager.viewportInfo.width / engine.glManager.viewportInfo.height, 0.1, 1000.0);

        var cameraFrustum = math3D.buildFrustumFromViewProjMatrix(cameraViewProjMatrix);

        var visibleWorldStaticMeshChunkIndexes = engine.visibilityManager.gatherVisibleWorldStaticMeshChunkIndexes(
            engine.camera.position, cameraFrustum);

        var visibleActorIds = engine.visibilityManager.gatherVisibleActorIds(
            engine.camera.position, cameraFrustum);

        var visibleLightIds = engine.visibilityManager.gatherVisibleLightIdsFromVisibleObjectsIds(
            visibleWorldStaticMeshChunkIndexes, visibleActorIds);

        engine.stats.numberOfVisibleWorldStaticMeshChunks = visibleWorldStaticMeshChunkIndexes.length;
        engine.stats.numberOfVisibleActors = visibleActorIds.length;
        engine.stats.numberOfVisibleLights = visibleLightIds.length;

        this.buildShadowMaps(visibleLightIds);

        this.renderingParameters.mode = 'main-render';

        gl.bindFramebuffer(gl.FRAMEBUFFER, null);

        gl.viewport(0, 0, engine.glManager.viewportInfo.width, engine.glManager.viewportInfo.height);

        gl.colorMask(true, true, true, true);
        gl.clearColor(0.0, 0.0, 0.0, 1.0);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

       

        gl.enable(gl.CULL_FACE);
        gl.cullFace(gl.BACK);

        gl.enable(gl.DEPTH_TEST);
        gl.depthFunc(gl.LEQUAL);

        gl.disable(gl.BLEND);

        this.renderingParameters.viewProjMatrix = cameraViewProjMatrix;

        this.prepareForStaticMeshMainRender();

        this.renderWorldStaticMesh(visibleWorldStaticMeshChunkIndexes);

        this.renderActorStaticMeshes(visibleActorIds);

        this.prepareForSkinnedMeshMainRender();

        this.renderActorSkinnedMeshes(visibleActorIds);

        this.renderLightVolumes();
  
        this.renderWorldStaticMeshChunkAABBs();

        this.renderActorIdentifiers();

        this.renderActorBoundingSpheres();
    }

    this.buildShadowMaps = function (visibleLightIds) {

        engine.stats.numberOfShadowMapsBuiltThisFrame = 0;

        this.renderingParameters.mode = 'shadow-map-build';

        for (var i = 0; i < visibleLightIds.length; i++) {

            var lightId = visibleLightIds[i];

            var light = engine.map.lightsById[lightId];

            if (!light.enabled) {
                continue;
            }

            this.buildShadowMapForLight(light);
        }
    }

    this.buildShadowMapForLight = function (light) {

        if (light == null) {
            throw 'Light not found.';
        }

        var lightRenderState = engine.renderStateManager.lightRenderStatesById[light.id];

        if (lightRenderState == null) {
            throw 'Light render state not found.';
        }

        if (light.type == 'point') {

            this.buildPointLightShadowMapForLight(light, lightRenderState);
        }
    }

    this.buildPointLightShadowMapForLight = function (light, lightRenderState) {

        var shadowMap = engine.shadowMapManager.shadowMaps[lightRenderState.shadowMapIndex];

        for (var faceIndex = 0; faceIndex < 6; faceIndex++) {

            var face = this.pointLightShadowMapFaces[faceIndex];

            var faceRenderState = lightRenderState.pointLightShadowMapFaceStates[faceIndex];

            for (var phase = 0; phase < 2; phase++) {

                var isWorldStaticMeshPhase = phase == 0;

                if (isWorldStaticMeshPhase && !faceRenderState.rebuildForStaticObjectsThisFrame) {
                    continue;
                }

                if (!isWorldStaticMeshPhase && !faceRenderState.rebuildForDynamicObjectsThisFrame) {
                    continue;
                }

                engine.stats.numberOfShadowMapsBuiltThisFrame++;

                for (var pass = 0; pass < 2; pass++) {

                    var isBackPass = pass == 0;

                    this.buildPointLightShadowMapFacePass(shadowMap, light, lightRenderState, face, faceRenderState, isBackPass, isWorldStaticMeshPhase);
                }
            }
        }
    }

    this.buildPointLightShadowMapFacePass = function (shadowMap, light, lightRenderState, face, faceRenderState, isBackPass, isWorldStaticMeshPhase) {

        var viewProjMatrix = engine.shadowMapManager.buildViewProjMatrixForPointLightCubeMapFaceBuild(light.position, face);

        this.renderingParameters.viewProjMatrix = viewProjMatrix;
        //this.renderingParameters.lightWorldPostion = light.position;

        var bufferSize = engine.shadowMapManager.bufferSize;

        gl.viewport(0, 0, bufferSize, bufferSize);
        gl.clearColor(10000.0, 10000.0, 10000.0, 10000.0);
        //gl.clearColor(0.0, 0.0, 0.0, 0.0);

        if (isWorldStaticMeshPhase) {
            gl.colorMask(lightRenderState.shadowMapChannel == 0, false, lightRenderState.shadowMapChannel == 1, false);
        } else {
            gl.colorMask(false, lightRenderState.shadowMapChannel == 0, false, lightRenderState.shadowMapChannel == 1);
        }

        gl.disable(gl.BLEND);

        if (isBackPass) {

            gl.bindFramebuffer(gl.FRAMEBUFFER, this.shadowMapBuildBuffers.backPassFrameBuffer);
            gl.clear(gl.DEPTH_BUFFER_BIT | gl.COLOR_BUFFER_BIT);

            gl.enable(gl.CULL_FACE);
            gl.cullFace(gl.FRONT);

            gl.enable(gl.DEPTH_TEST);
            gl.depthFunc(gl.LEQUAL);

        } else {

            gl.bindFramebuffer(gl.FRAMEBUFFER, shadowMap.frameBuffer);

            gl.framebufferTexture2D(
                gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, face.target, shadowMap.cubeTexture, 0);

            gl.clear(gl.COLOR_BUFFER_BIT);

            gl.enable(gl.CULL_FACE);
            gl.cullFace(gl.BACK);

            gl.enable(gl.DEPTH_TEST);
            gl.depthFunc(gl.LEQUAL);

            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, this.shadowMapBuildBuffers.backPassBufferTexture);
        }

        if (isWorldStaticMeshPhase) {

            if (isBackPass) {

                this.effect = engine.effectManager.useEffect('static-mesh-shadow-map-build-back-pass');

            } else {

                this.effect = engine.effectManager.useEffect('static-mesh-shadow-map-build-front-pass');
            }

            gl.uniform3fv(this.effect.uniforms.lightWorldPosition, light.position);
            gl.uniform4fv(this.effect.uniforms.shadowMapMask, this.shadowMapMasksForStaticObjectsByChannel[lightRenderState.shadowMapChannel]);
            gl.uniform1f(this.effect.uniforms.shadowMapSize, engine.shadowMapManager.bufferSize);
            
            this.renderWorldStaticMesh(faceRenderState.visibleWorldStaticMeshChunkIndexes);

            faceRenderState.lastStaticObjectBuildResult = ShadowMapBuildResult.Built;
        }
        else {

            // Render actor meshes.
            if (isBackPass) {

                this.effect = engine.effectManager.useEffect('static-mesh-shadow-map-build-back-pass');

            } else {

                this.effect = engine.effectManager.useEffect('static-mesh-shadow-map-build-front-pass');
            }

            gl.uniform3fv(this.effect.uniforms.lightWorldPosition, light.position);
            gl.uniform4fv(this.effect.uniforms.shadowMapMask, this.shadowMapMasksForDynamicObjectsByChannel[lightRenderState.shadowMapChannel]);
            gl.uniform1f(this.effect.uniforms.shadowMapSize, engine.shadowMapManager.bufferSize);

            if (faceRenderState.visibleActorIds.length > 0) {

                this.renderActorStaticMeshes(faceRenderState.visibleActorIds);

                // TODO - Actor skinned meshes.

                faceRenderState.lastDynamicObjectBuildResult = ShadowMapBuildResult.BuiltWithDynamicObjects;

            } else {

                faceRenderState.lastDynamicObjectBuildResult = ShadowMapBuildResult.BuiltWithoutDynamicObjects;
            }
        }
    }

    this.prepareForStaticMeshMainRender = function (options) {

        this.effect = engine.effectManager.useEffect('static-mesh-main-render');
    }

    this.prepareForSkinnedMeshMainRender = function (options) {

        this.effect = engine.effectManager.useEffect('skinned-mesh-main-render');
    }

    this.renderWorldStaticMesh = function (visibleChunkIndexes) {

        var staticMesh = engine.staticMeshManager.getStaticMesh(engine.map.worldStaticMeshId);

        if (staticMesh == null) {
            throw "World static mesh not loaded";
        }

        var options = { 
            staticMeshChunkRenderStatesByIndex: engine.renderStateManager.worldStaticMeshChunkRenderStatesByIndex,
            visibleChunkIndexes: visibleChunkIndexes
        };

        this.renderStaticMesh(staticMesh, options);
    }

    this.renderActorStaticMeshes = function (actorIds) {

        for (var i = 0; i < actorIds.length; i++) {

            var actorId = actorIds[i];

            var actor = engine.map.actorsById[actorId];

            if (actor.staticMeshId == null) {
                continue;
            }

            var staticMesh = engine.staticMeshManager.getStaticMesh(actor.staticMeshId);

            if (staticMesh == null) {
                continue;
            }

            var staticMeshRenderState = engine.renderStateManager.buildStaticMeshRenderState(staticMesh, actor.position);

            var options = {
                staticMeshRenderState: staticMeshRenderState,
                position: actor.position,
                rotation: actor.rotation
            };

            this.renderStaticMesh(staticMesh, options);
        }
    }

    this.renderActorSkinnedMeshes = function (actorIds) {

        //for (var i = 0; i < actorIds.length; i++) {

        //var actorId = actorIds[i];

        for (var actorId in engine.map.actorsById) { // FIXME

            var actor = engine.map.actorsById[actorId];

            if (actor.skinnedMeshId == null) {
                continue;
            }

            var skinnedMesh = engine.skinnedMeshManager.getSkinnedMesh(actor.skinnedMeshId);

            if (skinnedMesh == null) {
                continue;
            }

            var skinnedMeshAnimation = engine.skinnedMeshAnimationManager.getSkinnedMeshAnimation(actor.skinnedMeshAnimationId);

            if (skinnedMeshAnimation == null) {
                continue;
            }

            var options = {
                position: actor.position,
                rotation: actor.rotation,
                frameIndex: actor.frameIndex
            };

            this.renderSkinnedMesh(skinnedMesh, skinnedMeshAnimation, options);
        }
    }

    this.renderStaticMesh = function (staticMesh, options) {

        // Check the parameters.
        if (staticMesh == null) {
            throw "Static mesh is null!";
        }

        if (options.staticMeshRenderState == null && options.staticMeshChunkRenderStatesByIndex == null) {
            throw "We can't render a static mesh without render states!";
        }

        // Ensure we have visible chunk indexes.
        if (options.visibleChunkIndexes == null) {
            options.visibleChunkIndexes = [];
            for (var chunkIndex = 0; chunkIndex < staticMesh.chunks.length; chunkIndex++) {
                options.visibleChunkIndexes.push(chunkIndex);
            }
        }

        // Build the translation matrix.
        var translationMatrix = mat4.create();

        if (options.position != null) {
            mat4.translate(translationMatrix, translationMatrix, options.position);
        }

        // Build the rotation matrix.
        var rotationMatrix = mat4.create();

        if (options.rotation != null) {
            mat4.rotateX(rotationMatrix, rotationMatrix, options.rotation[0]);
            mat4.rotateY(rotationMatrix, rotationMatrix, options.rotation[1]);
            mat4.rotateZ(rotationMatrix, rotationMatrix, options.rotation[2]);
        }

        // Build the world matrix.
        var worldMatrix = mat4.create();

        mat4.multiply(worldMatrix, translationMatrix, rotationMatrix);

        if (this.effect.uniforms.rotationMatrix != null) {
            gl.uniformMatrix4fv(this.effect.uniforms.rotationMatrix, false, rotationMatrix);
        }

        if (this.effect.uniforms.worldMatrix != null) {
            gl.uniformMatrix4fv(this.effect.uniforms.worldMatrix, false, worldMatrix);
        }

        if (this.effect.uniforms.viewProjMatrix != null) {
            gl.uniformMatrix4fv(this.effect.uniforms.viewProjMatrix, false, this.renderingParameters.viewProjMatrix);
        }

        // Bind the static mesh's buffers to the effect.
        this.bindStaticMeshBuffersToEffect(staticMesh);

        // Render the chunks.
        for (var i = 0; i < options.visibleChunkIndexes.length; i++) {

            var chunkIndex = options.visibleChunkIndexes[i];
            var chunk = staticMesh.chunks[chunkIndex];

            if (this.renderingParameters.mode == 'main-render') {

                this.prepareStaticMeshChunkForMainRender(chunk, chunkIndex, options);
            }

            gl.drawElements(gl.TRIANGLES, chunk.numFaces * 3, gl.UNSIGNED_SHORT, chunk.startIndex * 2);
        }
    }
    //var test = 0;
    this.renderSkinnedMesh = function (skinnedMesh, skinnedMeshAnimation, options) {

        // Check the parameters.
        if (skinnedMesh == null) {
            throw "Skinned mesh is null!";
        }

        if (skinnedMeshAnimation == null) {
            throw "Skinned mesh animation is null!";
        }

       /* if (options.staticMeshRenderState == null && options.staticMeshChunkRenderStatesByIndex == null) {
            throw "We can't render a static mesh without render states!";
        }*/

        // Build the translation matrix.
        var translationMatrix = mat4.create();

        if (options.position != null) {
            mat4.translate(translationMatrix, translationMatrix, options.position);
        }

        // Build the rotation matrix.
        var rotationMatrix = mat4.create();

        if (options.rotation != null) {
            mat4.rotateX(rotationMatrix, rotationMatrix, options.rotation[0]);
            mat4.rotateY(rotationMatrix, rotationMatrix, options.rotation[1]);
            mat4.rotateZ(rotationMatrix, rotationMatrix, options.rotation[2]);
        }

        // Build the world matrix.
        var worldMatrix = mat4.create();

        mat4.multiply(worldMatrix, translationMatrix, rotationMatrix);

        if (this.effect.uniforms.rotationMatrix != null) {
            gl.uniformMatrix4fv(this.effect.uniforms.rotationMatrix, false, rotationMatrix);
        }

        if (this.effect.uniforms.worldMatrix != null) {
            gl.uniformMatrix4fv(this.effect.uniforms.worldMatrix, false, worldMatrix);
        }

        if (this.effect.uniforms.viewProjMatrix != null) {
            gl.uniformMatrix4fv(this.effect.uniforms.viewProjMatrix, false, this.renderingParameters.viewProjMatrix);
        }

        if (this.effect.uniforms.boneMatrices != null) {

            /*var boneMatrix = mat4.create();
            mat4.translate(boneMatrix, boneMatrix, [0, -0.805583, 0.860142]);
            //mat4.rotateZ(boneMatrix, boneMatrix, test); test -= 0.01;
            mat4.rotateZ(boneMatrix, boneMatrix, 0.012743);
            mat4.rotateY(boneMatrix, boneMatrix, -1.568372);
            mat4.rotateX(boneMatrix, boneMatrix, -1.583519);
            mat4.translate(boneMatrix, boneMatrix, [-0.000000, 0.805583, -0.860142]);

            gl.uniformMatrix4fv(this.effect.uniforms.boneMatrices, false, boneMatrix);*/

            var boneMatrices = this.buildSkinnedMeshAnimationBoneMatricesForFrame(skinnedMesh, skinnedMeshAnimation, options.frameIndex);
            var concatenatedBoneMatrices = math3D.concatenateMatricesToSingleArray(boneMatrices);

            gl.uniformMatrix4fv(this.effect.uniforms.boneMatrices, false, concatenatedBoneMatrices);
        }

        // Bind the skinned mesh's buffers to the effect.
        this.bindSkinnedMeshBuffersToEffect(skinnedMesh);

        /// TEMPORARY CODE ////
        gl.uniform1i(this.effect.uniforms.diffuseSampler, 0);

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.coalesceTexture('system/missing-diffuse-texture'));
        ////////////////////////

        // Draw the skinned mesh's triangles.
        gl.drawArrays(gl.TRIANGLES, 0, skinnedMesh.numberOfFaces);
    }

    this.buildSkinnedMeshAnimationBoneMatricesForFrame = function (skinnedMesh, skinnedMeshAnimation, frameIndex) {

        var boneMatrices = [];

        var fromFrameIndex = Math.floor(frameIndex);
        var toFrameIndex = fromFrameIndex + 1;
        if (toFrameIndex >= skinnedMeshAnimation.frames.length) {
            toFrameIndex = 0;
        }

        var lerpFactor = frameIndex - fromFrameIndex;

        var fromAnimationFrame = skinnedMeshAnimation.frames[fromFrameIndex];
        var toAnimationFrame = skinnedMeshAnimation.frames[toFrameIndex];

        for (var boneIndex = 0; boneIndex < this.maxSkinnedMeshBones; boneIndex++) {

            var boneMatrix = mat4.create();

            var bone = skinnedMesh.bones[boneIndex];

            if (bone != null) {

                var inversePosition = vec3.create();
                vec3.scale(inversePosition, bone.position, -1);

                var fromBoneTransform = fromAnimationFrame.trans[boneIndex];
                var toBoneTransform = toAnimationFrame.trans[boneIndex];

                var slerpedRotationQuaternion = quat.create();
                quat.slerp(slerpedRotationQuaternion, fromBoneTransform.quat, toBoneTransform.quat, lerpFactor);

                mat4.translate(boneMatrix, boneMatrix, bone.position);

                var rotationMatrix = mat4.create();
                mat4.fromQuat(rotationMatrix, slerpedRotationQuaternion);
                mat4.multiply(boneMatrix, boneMatrix, rotationMatrix);

                mat4.translate(boneMatrix, boneMatrix, inversePosition);
            }

            /*if (boneIndex == 0) {

                var inversePosition = vec3.create();
                vec3.scale(inversePosition, bone.position, -1);

                mat4.translate(boneMatrix, boneMatrix, bone.position);
                //mat4.rotateX(boneMatrix, boneMatrix, -0.5);


                var rotationMatrix = mat4.create();
                //mat4.fromQuat(rotationMatrix, quat.fromValues(-0.3827, 0.0000, -0.0000, 0.9239)); // About X (correct)
                //mat4.fromQuat(rotationMatrix, quat.fromValues(0.0000, 0.3827, -0.0000, 0.9239)); // About Y (correct)
               // mat4.fromQuat(rotationMatrix, quat.fromValues(0.2706, -0.6533, -0.2706,  0.6533)); // About X if correct
                
                mat4.multiply(boneMatrix, boneMatrix, rotationMatrix);

                mat4.translate(boneMatrix, boneMatrix, inversePosition);

            }

            if (boneIndex == 1) {

                var inversePosition = vec3.create();
                vec3.scale(inversePosition, bone.position, -1);

                mat4.translate(boneMatrix, boneMatrix, bone.position);
                //mat4.rotateZ(boneMatrix, boneMatrix, 0.9);


                var rotationMatrix = mat4.create();
                mat4.fromQuat(rotationMatrix, quat.fromValues(0.0000, -0.3827, 0.0000, 0.9239));
                mat4.multiply(boneMatrix, boneMatrix, rotationMatrix);

                mat4.translate(boneMatrix, boneMatrix, inversePosition);

            }

            if (boneIndex == 2) {

                var inversePosition = vec3.create();
                vec3.scale(inversePosition, bone.position, -1);

                mat4.translate(boneMatrix, boneMatrix, bone.position);
                //mat4.rotateX(boneMatrix, boneMatrix, -0.5);

        
                var rotationMatrix = mat4.create();
                mat4.fromQuat(rotationMatrix, quat.fromValues(0.0000, -0.3827, 0.0000, 0.9239));
                mat4.multiply(boneMatrix, boneMatrix, rotationMatrix);

                mat4.translate(boneMatrix, boneMatrix, inversePosition);

            }

            if (boneIndex == 3) {

                var inversePosition = vec3.create();
                vec3.scale(inversePosition, bone.position, -1);

                mat4.translate(boneMatrix, boneMatrix, bone.position);
                //mat4.rotateX(boneMatrix, boneMatrix, 0.5);


                var rotationMatrix = mat4.create();
               // mat4.fromQuat(rotationMatrix, quat.fromValues(-0.003, 0.0005246, -0.383, 0.924)); // About Z
                mat4.multiply(boneMatrix, boneMatrix, rotationMatrix);

                mat4.translate(boneMatrix, boneMatrix, inversePosition);

            }

            if (boneIndex == 4) {

                var inversePosition = vec3.create();
                vec3.scale(inversePosition, bone.position, -1);

                mat4.translate(boneMatrix, boneMatrix, bone.position);
                //mat4.rotateZ(boneMatrix, boneMatrix, 0.5);


                var rotationMatrix = mat4.create();
               // mat4.fromQuat(rotationMatrix, quat.fromValues(-0.003, 0.0005246, -0.383, 0.924)); // About Z
                mat4.multiply(boneMatrix, boneMatrix, rotationMatrix);

                mat4.translate(boneMatrix, boneMatrix, inversePosition);

            }*/
            
            //mat4.fromQuat(boneMatrix, quat.fromValues(-0.371, 0.0, 0.0, 0.929));
            //mat4.fromQuat(boneMatrix, quat.fromValues(-0.341, 0.147, -0.367, 0.853));

            boneMatrices.push(boneMatrix);
        }

        //test += 0.01;

        boneMatrices = this.applyHierachyToSkinnedMeshBoneMatrices(skinnedMesh, boneMatrices);

        return boneMatrices;
    }

    this.applyHierachyToSkinnedMeshBoneMatrices = function (skinnedMesh, boneMatrices) {

        var hierachicalBoneMatrices = [];

        for (var boneIndex = 0; boneIndex < this.maxSkinnedMeshBones; boneIndex++) {

            var bone = skinnedMesh.bones[boneIndex];
            if (bone == null) {
                continue;
            }

            var hierachicalBoneMatrix = mat4.clone(boneMatrices[boneIndex]);

            var ancestorBoneIndex = bone.parentBoneIndex;

            while (ancestorBoneIndex != -1) {

                var ancestorBone = skinnedMesh.bones[ancestorBoneIndex];
                var ancestorMatrix = boneMatrices[ancestorBoneIndex];

                mat4.multiply(hierachicalBoneMatrix, ancestorMatrix, hierachicalBoneMatrix);

                ancestorBoneIndex = ancestorBone.parentBoneIndex;
            }

            hierachicalBoneMatrices.push(hierachicalBoneMatrix);
        }

        return hierachicalBoneMatrices;
    }

    this.bindStaticMeshBuffersToEffect = function (staticMesh) {

        // Bind the vertex buffer.
        if (this.effect.attributes.vertexPosition != null) {
            gl.bindBuffer(gl.ARRAY_BUFFER, staticMesh.buffers.vertexBuffer);
            gl.vertexAttribPointer(
                this.effect.attributes.vertexPosition,
                3, gl.FLOAT, false, 0, 0);
            gl.enableVertexAttribArray(this.effect.attributes.vertexPosition);
        }

        // Bind the normals buffer.
        if (this.effect.attributes.vertexNormal != null) {
            gl.bindBuffer(gl.ARRAY_BUFFER, staticMesh.buffers.normalsBuffer);
            gl.vertexAttribPointer(
                this.effect.attributes.vertexNormal,
                3, gl.FLOAT, false, 0, 0);
            gl.enableVertexAttribArray(this.effect.attributes.vertexNormal);
        }

        // Bind the tangents buffer.
        if (this.effect.attributes.vertexTangent != null) {
            gl.bindBuffer(gl.ARRAY_BUFFER, staticMesh.buffers.tangentsBuffer);
            gl.vertexAttribPointer(
                this.effect.attributes.vertexTangent,
                3, gl.FLOAT, false, 0, 0);
            gl.enableVertexAttribArray(this.effect.attributes.vertexTangent);
        }

        // Bind the bitangents buffer.
        if (this.effect.attributes.vertexBitangent != null) {
            gl.bindBuffer(gl.ARRAY_BUFFER, staticMesh.buffers.bitangentsBuffer);
            gl.vertexAttribPointer(
                this.effect.attributes.vertexBitangent,
                3, gl.FLOAT, false, 0, 0);
            gl.enableVertexAttribArray(this.effect.attributes.vertexBitangent);
        }

        // Bind the tex coord buffer.
        if (this.effect.attributes.vertexTexCoord != null) {
            gl.bindBuffer(gl.ARRAY_BUFFER, staticMesh.buffers.texCoordBuffer);
            gl.vertexAttribPointer(
                this.effect.attributes.vertexTexCoord,
                2, gl.FLOAT, false, 0, 0);
            gl.enableVertexAttribArray(this.effect.attributes.vertexTexCoord);
        }

        // Bind the index buffer.
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, staticMesh.buffers.indexBuffer);
    }

    this.bindSkinnedMeshBuffersToEffect = function (skinnedMesh) {

        // Bind the vertex buffer.
        if (this.effect.attributes.vertexPosition != null) {
            gl.bindBuffer(gl.ARRAY_BUFFER, skinnedMesh.buffers.vertexBuffer);
            gl.vertexAttribPointer(
                this.effect.attributes.vertexPosition,
                3, gl.FLOAT, false, 0, 0);
            gl.enableVertexAttribArray(this.effect.attributes.vertexPosition);
        }

        // Bind the normals buffer.
        if (this.effect.attributes.vertexNormal != null) {
            gl.bindBuffer(gl.ARRAY_BUFFER, skinnedMesh.buffers.normalsBuffer);
            gl.vertexAttribPointer(
                this.effect.attributes.vertexNormal,
                3, gl.FLOAT, false, 0, 0);
            gl.enableVertexAttribArray(this.effect.attributes.vertexNormal);
        }

        // Bind the tex coord buffer.
        if (this.effect.attributes.vertexTexCoord != null) {
            gl.bindBuffer(gl.ARRAY_BUFFER, skinnedMesh.buffers.texCoordBuffer);
            gl.vertexAttribPointer(
                this.effect.attributes.vertexTexCoord,
                2, gl.FLOAT, false, 0, 0);
            gl.enableVertexAttribArray(this.effect.attributes.vertexTexCoord);
        }

        // Bind the first bone indexes.
        if (this.effect.attributes.firstBoneIndex != null) {
            gl.bindBuffer(gl.ARRAY_BUFFER, skinnedMesh.buffers.firstBoneIndexes);
            gl.vertexAttribPointer(
                this.effect.attributes.firstBoneIndex,
                1, gl.FLOAT, false, 0, 0);
            gl.enableVertexAttribArray(this.effect.attributes.firstBoneIndex);
        }

        // Bind the second bone indexes.
        if (this.effect.attributes.secondBoneIndex != null) {
            gl.bindBuffer(gl.ARRAY_BUFFER, skinnedMesh.buffers.secondBoneIndexes);
            gl.vertexAttribPointer(
                this.effect.attributes.secondBoneIndex,
                1, gl.FLOAT, false, 0, 0);
            gl.enableVertexAttribArray(this.effect.attributes.secondBoneIndex);
        }

        // Bind the third bone indexes.
        if (this.effect.attributes.thirdBoneIndex != null) {
            gl.bindBuffer(gl.ARRAY_BUFFER, skinnedMesh.buffers.thirdBoneIndexes);
            gl.vertexAttribPointer(
                this.effect.attributes.thirdBoneIndex,
                1, gl.FLOAT, false, 0, 0);
            gl.enableVertexAttribArray(this.effect.attributes.thirdBoneIndex);
        }

        // Bind the fourth bone indexes.
        if (this.effect.attributes.fourthBoneIndex != null) {
            gl.bindBuffer(gl.ARRAY_BUFFER, skinnedMesh.buffers.fourthBoneIndexes);
            gl.vertexAttribPointer(
                this.effect.attributes.fourthBoneIndex,
                1, gl.FLOAT, false, 0, 0);
            gl.enableVertexAttribArray(this.effect.attributes.fourthBoneIndex);
        }

        // Bind the first weights.
        if (this.effect.attributes.firstWeight != null) {
            gl.bindBuffer(gl.ARRAY_BUFFER, skinnedMesh.buffers.firstWeights);
            gl.vertexAttribPointer(
                this.effect.attributes.firstWeight,
                1, gl.FLOAT, false, 0, 0);
            gl.enableVertexAttribArray(this.effect.attributes.firstWeight);
        }

        // Bind the second weights.
        if (this.effect.attributes.secondWeight != null) {
            gl.bindBuffer(gl.ARRAY_BUFFER, skinnedMesh.buffers.secondWeights);
            gl.vertexAttribPointer(
                this.effect.attributes.secondWeight,
                1, gl.FLOAT, false, 0, 0);
            gl.enableVertexAttribArray(this.effect.attributes.secondWeight);
        }

        // Bind the third weights.
        if (this.effect.attributes.thirdWeight != null) {
            gl.bindBuffer(gl.ARRAY_BUFFER, skinnedMesh.buffers.thirdWeights);
            gl.vertexAttribPointer(
                this.effect.attributes.thirdWeight,
                1, gl.FLOAT, false, 0, 0);
            gl.enableVertexAttribArray(this.effect.attributes.thirdWeight);
        }

        // Bind the fourth weights.
        if (this.effect.attributes.fourthWeight != null) {
            gl.bindBuffer(gl.ARRAY_BUFFER, skinnedMesh.buffers.fourthWeights);
            gl.vertexAttribPointer(
                this.effect.attributes.fourthWeight,
                1, gl.FLOAT, false, 0, 0);
            gl.enableVertexAttribArray(this.effect.attributes.fourthWeight);
        }
    }

    this.prepareStaticMeshChunkForMainRender = function (chunk, chunkIndex, options) {

        // Resolve the effective light IDs, either from the chunk render states (e.g. for the world static mesh) or 
        // from the static mesh render state (for actors ands such like).
        var effectiveLightIds = null;

        if (options.staticMeshChunkRenderStatesByIndex != null) {

            var chunkRenderState = options.staticMeshChunkRenderStatesByIndex[chunkIndex];

            if (chunkRenderState == null) {
                throw "Render state not found for chunk.";
            }

            effectiveLightIds = chunkRenderState.effectiveLightIds;

        } else {

            effectiveLightIds = options.staticMeshRenderState.effectiveLightIds;
        }

        var effectiveLights = this.gatherLightsFromLightIds(effectiveLightIds);

        var material = this.coalesceMaterial(chunk.materialId);

        this.prepareStandardMaterial(material, this.effect, effectiveLights, engine.camera);
    }

    this.gatherLightsFromLightIds = function (lightIds) {

        var lights = [];

        for (var i = 0; i < lightIds.length; i++) {

            var lightId = lightIds[i];
            var light = engine.map.lightsById[lightId];

            if (light != null) {
                lights.push(light);
            }
        }

        return lights;
    }

    this.renderLightVolumes = function () {

        for (var lightId in engine.map.lightsById) {

            var light = engine.map.lightsById[lightId];

            if (this.renderingOptions.renderLightVolumes || this.renderingOptions.renderLightVolumeForLightId == light.id) {

                engine.lineDrawer.drawSphere(this.renderingParameters, light.position, 0.1, light.colour, true);
                engine.lineDrawer.drawSphere(this.renderingParameters, light.position, light.radius, [1, 1, 1], true);
            }
        }
    }

    this.renderWorldStaticMeshChunkAABBs = function () {

        if (!this.renderingOptions.renderWorldMeshChunkAABBs) {
            return;
        }

        var staticMesh = engine.staticMeshManager.getStaticMesh(engine.map.worldStaticMeshId);

        if (staticMesh == null) {
            return;
        }

        for (var i = 0; i < staticMesh.chunks.length; i++) {

            var chunk = staticMesh.chunks[i];

            engine.lineDrawer.drawCube(this.renderingParameters, chunk.aabb.from, math3D.calculateAABBSize(chunk.aabb), [1, 1, 1], false);
        }
    }

    this.renderActorIdentifiers = function () {

        if (!this.renderingOptions.renderActorIdentifiers) {
            return;
        }

        for (var actorId in engine.map.actorsById) {

            var actor = engine.map.actorsById[actorId];

            engine.lineDrawer.drawSphere(this.renderingParameters, actor.position, 0.1, [1, 0, 0], false);
        }
    }

    this.renderActorBoundingSpheres = function () {

        if (!this.renderingOptions.renderActorBoundingSpheres) {
            return;
        }

        for (var actorId in engine.map.actorsById) {

            var actor = engine.map.actorsById[actorId];;

            if (actor.staticMeshId == null) {
                continue;
            }

            var staticMesh = engine.staticMeshManager.getStaticMesh(actor.staticMeshId);

            if (staticMesh == null) {
                continue;
            }

            engine.lineDrawer.drawSphere(this.renderingParameters, actor.position, staticMesh.rotationSafeBoundingSphereRadius, [1, 0, 0], false);
        }
    }

    this.prepareStandardMaterial = function (material, effect, lights, camera) {

        var lightEnableds = [];
        var lightPositions = [];
        var lightRadiusSqrs = [];
        var lightColours = [];
        var lightStaticObjectShadowMapMasks = [];
        var lightDynamicObjectShadowMapMasks = [];
        var pointLightShadowMapSamplers = [];

        for (var i = 0; i < this.maxStandardMaterialLights; i++) {

            var light = lights[i];

            if (light != null && light.enabled && light.radius > 0) {

                var lightRenderState = engine.renderStateManager.lightRenderStatesById[light.id];

                lightEnableds.push(1);
                util.arrayPushMany(lightPositions, light.position);
                lightRadiusSqrs.push(light.radius * light.radius);
                util.arrayPushMany(lightColours, light.colour);
                util.arrayPushMany(lightStaticObjectShadowMapMasks, this.shadowMapMasksForStaticObjectsByChannel[lightRenderState.shadowMapChannel]);
                util.arrayPushMany(lightDynamicObjectShadowMapMasks, this.shadowMapMasksForDynamicObjectsByChannel[lightRenderState.shadowMapChannel]);
                pointLightShadowMapSamplers.push(6 + i);

                gl.activeTexture(gl.TEXTURE6 + i);
                gl.bindTexture(gl.TEXTURE_CUBE_MAP, engine.shadowMapManager.shadowMaps[lightRenderState.shadowMapIndex].cubeTexture);

            } else {

                lightEnableds.push(0);
                util.arrayPushMany(lightPositions, [0, 0, 0]);
                lightRadiusSqrs.push(0);
                util.arrayPushMany(lightColours, [0, 0, 0]);
                util.arrayPushMany(lightStaticObjectShadowMapMasks, [0, 0, 0, 0]);
                util.arrayPushMany(lightDynamicObjectShadowMapMasks, [0, 0, 0, 0]);
                pointLightShadowMapSamplers.push(3); // Point it at the reflection-cube texture unit, so that it always has something to point to, even if it isn't used.
            }
        }

        gl.uniform1iv(effect.uniforms.lightEnableds, lightEnableds);
        gl.uniform3fv(effect.uniforms.lightWorldSpacePositions, lightPositions);
        gl.uniform1fv(effect.uniforms.lightRadiusSqrs, lightRadiusSqrs);
        gl.uniform3fv(effect.uniforms.lightColours, lightColours);
        gl.uniform4fv(effect.uniforms.lightStaticObjectShadowMapMasks, lightStaticObjectShadowMapMasks);
        gl.uniform4fv(effect.uniforms.lightDynamicObjectShadowMapMasks, lightDynamicObjectShadowMapMasks);
        gl.uniform3fv(effect.uniforms.cameraWorldSpacePosition, camera.position);
        gl.uniform3fv(effect.uniforms.globalIlluminationNormals, this.globalIlluminationNormals);
        gl.uniform3fv(effect.uniforms.globalIlluminationColours, this.globalIlluminationColours);
        
        //gl.uniform3fv(effect.uniforms.globalIlluminationColour, engine.map.globalIllumination.colour);
       
        gl.uniform1i(effect.uniforms.hasSelfIllumination, material.selfIlluminationTextureId != null);

        gl.uniform1i(effect.uniforms.diffuseSampler, 0);
        gl.uniform1i(effect.uniforms.normalSampler, 1);
        gl.uniform1i(effect.uniforms.selfIlluminationSampler, 2);
        //gl.uniform1i(effect.uniforms.globalIlluminationSampler, 5);
        gl.uniform1iv(effect.uniforms.pointLightShadowMapSamplers, pointLightShadowMapSamplers);

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.coalesceTexture(material.diffuseTextureId, 'system/missing-diffuse-texture'));

        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.coalesceTexture(material.normalTextureId, 'system/missing-normal-texture'));

        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, this.coalesceTexture(material.selfIlluminationTextureId, 'system/missing-diffuse-texture'));

        gl.activeTexture(gl.TEXTURE3);
        gl.bindTexture(gl.TEXTURE_CUBE_MAP, this.coalesceTexture(null, 'system/dummy-cube')); // FIXME

        //gl.activeTexture(gl.TEXTURE5);
        //gl.bindTexture(gl.TEXTURE_CUBE_MAP, engine.textureManager.getTexture('system/gi-cube'));
    }

    this.coalesceMaterial = function (materialId) {

        var material = engine.materialManager.getMaterial(materialId);
        
        if (material == null) {

            engine.materialManager.loadMaterial(materialId);

            material = {
            
            }
        }

        return material;
    }

    this.coalesceTexture = function (textureId, fallbackTextureId) {

        var texture = engine.textureManager.getTexture(textureId);
 
        if (texture == null) {

            engine.textureManager.loadTexture(textureId);

            texture = engine.textureManager.getTexture(fallbackTextureId);
        }

        return texture;
    }

    this.log = function (message) {

        console.log('Renderer: ' + message);
    }
}