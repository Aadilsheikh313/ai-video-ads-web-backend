import { Request, Response } from "express";
import * as Sentry from "@sentry/node";
import { prisma } from "../configs/prisma.js";
import { v2 as Cloudinary } from "cloudinary";
import fs from "fs";
import axios from "axios";
import { Client, handle_file } from "@gradio/client";

const HF_TOKEN = process.env.HF_TOKEN;

const HF_IMAGE_SPACE =
    process.env.HF_IMAGE_SPACE ||
    "prithivMLmods/FLUX.2-Klein-LoRA-Studio";

const HF_VIDEO_SPACE =
    process.env.HF_VIDEO_SPACE ||
    "zerogpu-aoti/wan2-2-fp8da-aoti-faster";

if (!HF_TOKEN) {
    console.error("WARNING: HF_TOKEN is not defined in .env");
}

/**
 * Convert a local uploaded image into a data URL.
 * The FLUX.2 Klein Space accepts multiple reference images
 * as a JSON array of base64/data URLs.
 */
const localImageToDataUrl = (filePath: string, mimeType: string) => {
    const base64 = fs.readFileSync(filePath).toString("base64");
    return `data:${mimeType || "image/jpeg"};base64,${base64}`;
};

const requireHFToken = () => {
    if (!HF_TOKEN) {
        throw new Error("HF_TOKEN is missing in server .env");
    }
};

const getHFClient = async (space: string) => {
    requireHFToken();

    return Client.connect(space, {
        token: HF_TOKEN,
    });
};

/**
 * Extract a value returned by a Gradio endpoint.
 * Different Gradio versions can return arrays or objects.
 */
const firstGradioValue = (data: any) => {
    if (Array.isArray(data)) return data[0];
    return data;
};

const extractImageDataUrl = (data: any): string | null => {
    const value = firstGradioValue(data);

    if (typeof value === "string") {
        if (value.startsWith("data:image/")) return value;

        // Some endpoints can return a URL instead of a data URL.
        if (value.startsWith("http://") || value.startsWith("https://")) {
            return value;
        }
    }

    if (value && typeof value === "object") {
        if (typeof value.image === "string") return value.image;
        if (typeof value.url === "string") return value.url;
        if (typeof value.path === "string") return value.path;
    }

    return null;
};

const extractVideoReference = (data: any): string | null => {
    const value = firstGradioValue(data);

    if (typeof value === "string") {
        return value;
    }

    if (value && typeof value === "object") {
        if (typeof value.url === "string") return value.url;
        if (typeof value.path === "string") return value.path;
        if (typeof value.name === "string") return value.name;
    }

    return null;
};

/**
 * FLUX.2 Klein multi-reference image generation.
 *
 * IMPORTANT:
 * The Space uses the FIRST reference image to determine output dimensions.
 * We therefore send the MODEL image first so a portrait model photo produces
 * a portrait-friendly result. The prompt explicitly tells the model which
 * reference is the model and which is the product.
 */
const generateCompositeImage = async ({
    productPath,
    productMime,
    modelPath,
    modelMime,
    prompt,
}: {
    productPath: string;
    productMime: string;
    modelPath: string;
    modelMime: string;
    prompt: string;
}) => {
    const app = await getHFClient(HF_IMAGE_SPACE);

    const modelDataUrl = localImageToDataUrl(modelPath, modelMime);
    const productDataUrl = localImageToDataUrl(productPath, productMime);

    const references = JSON.stringify([
        modelDataUrl,
        productDataUrl,
    ]);

    const result: any = await app.predict("/edit_image", [
        references,
        prompt,
        "None",
        0,
        true,
        1.0,
        4,
    ]);

    const image = extractImageDataUrl(result?.data);

    if (!image) {
        console.error("HF image response:", JSON.stringify(result));
        throw new Error("Hugging Face did not return a generated image");
    }

    return image;
};

/**
 * Discover the current image-to-video endpoint exposed by the
 * configured Hugging Face Space so small Space-side UI changes
 * do not immediately break this backend.
 */
const findVideoEndpoint = async (app: any) => {
    const api = await app.view_api();

    const named = api?.named_endpoints || {};

    const entries = Object.entries(named) as [string, any][];

    const match = entries.find(([_, endpoint]) => {
        const params = endpoint?.parameters || [];
        const labels = params
            .map((p: any) => `${p.label || ""} ${p.type || ""}`.toLowerCase())
            .join(" ");

        return (
            labels.includes("image") &&
            labels.includes("prompt") &&
            (labels.includes("duration") || labels.includes("frames"))
        );
    });

    if (!match) {
        throw new Error(
            `No compatible image-to-video endpoint found in ${HF_VIDEO_SPACE}`
        );
    }

    return match;
};
const buildVideoPayload = (
    parameters: any[],
    project: any,
    videoPrompt: string
) => {
    /*
     * Wan 2.2 Fast automatically resizes the input image
     * to a supported resolution. It does not expose height/width
     * as API inputs, so we only send values for parameters that
     * actually exist in the endpoint.
     */

    const negativePrompt =
        "static, blurry, distorted face, deformed hands, extra fingers, " +
        "warped product, duplicate product, changing clothes, changing face, " +
        "text, watermark, logo distortion, flicker, camera shake";

    console.log("========== WAN VIDEO SETTINGS ==========");
    console.log("Aspect Ratio:", project.aspectRatio);
    console.log("Duration: 2 seconds");
    console.log("Steps: 4");
    console.log("Guidance: 1");
    console.log("========================================");

    return parameters.map((parameter: any) => {
        const label =
            `${parameter.label || ""} ${parameter.type || ""}`
                .toLowerCase();

        // INPUT IMAGE
        if (
            label.includes("input image") ||
            label.includes("image")
        ) {
            return handle_file(project.generatedImage);
        }

        // NEGATIVE PROMPT
        if (label.includes("negative")) {
            return negativePrompt;
        }

        // NORMAL PROMPT
        if (label.includes("prompt")) {
            return videoPrompt;
        }

        // DURATION
        if (
            label.includes("duration") ||
            label.includes("seconds")
        ) {
            return 5;
        }

        // GUIDANCE SCALE 2 (Wan 2.2)
        if (label.includes("guidance scale 2") || label.includes("guidance 2")) {
            return 1;
        }

        // GUIDANCE SCALE
        if (label.includes("guidance")) {
            return 1;
        }

        // STEPS
        if (label.includes("steps")) {
            return 4;
        }

        // RANDOMIZE SEED
        if (label.includes("randomize")) {
            return true;
        }

        // SEED
        if (label.includes("seed")) {
            return Math.floor(
                Math.random() * 2147483647
            );
        }

        // If HF provides a default, use it.
        if (parameter.default !== undefined) {
            return parameter.default;
        }

        // Generic numeric fallback
        if (
            parameter.type === "number" ||
            parameter.type === "integer" ||
            parameter.component === "Slider"
        ) {
            return 1;
        }

        // Generic boolean fallback
        if (
            parameter.type === "boolean" ||
            parameter.component === "Checkbox"
        ) {
            return false;
        }

        return "";
    });
};
// ========================================================
// 1. CREATE PROJECT — Hugging Face multi-reference image
// ========================================================
export const createProject = async (req: Request, res: Response) => {
    let tempProjectId: string | undefined;
    const { userId } = (req as any).auth();
    let isCreditDeducted = false;

    const {
        name = "New Project",
        aspectRatio = "9:16",
        userPrompt = "",
        productName,
        productDescription = "",
        targetLength = 5,
    } = req.body;

    const images = (req.files as Express.Multer.File[]) || [];

    if (!images || images.length < 2 || !productName) {
        return res.status(400).json({
            message:
                "Please upload 2 images (Product & Model) and provide product name",
        });
    }

    const user = await prisma.user.findUnique({
        where: { id: userId },
    });

    if (!user || user.credits < 5) {
        return res.status(401).json({
            message: "Insufficient credits. Please upgrade your plan.",
        });
    }

    await prisma.user.update({
        where: { id: userId },
        data: { credits: { decrement: 5 } },
    });

    isCreditDeducted = true;

    try {
        const uploadedImages = await Promise.all(
            images.map(async (item) => {
                const result = await Cloudinary.uploader.upload(item.path, {
                    resource_type: "image",
                });

                return result.secure_url;
            })
        );

        const project = await prisma.project.create({
            data: {
                name,
                userId,
                productName,
                productDescription,
                userPrompt,
                aspectRatio,
                targetLength: parseInt(targetLength.toString()) || 5,
                uploadedImages,
                isGenerating: true,
            },
        });

        tempProjectId = project.id;

        const productImage = images[0];
        const modelImage = images[1];

        /**
         * The model receives TWO references:
         * 1. model photo
         * 2. product photo
         *
         * It must create ONE new commercial photo, not a collage.
         */
        const promptText = `
Create one photorealistic UGC/product advertisement image.

REFERENCE IMAGE 1 = THE MODEL.
REFERENCE IMAGE 2 = THE PRODUCT.

Use the exact person from reference image 1 as the model.
Preserve the person's identity, face, skin tone, hair, body proportions,
clothing style and realistic appearance.

Use the exact product from reference image 2.
Preserve the product's shape, material, color, branding, handles, wheels,
logos and important physical details. Do NOT redesign the product.

COMPOSITION:
The model is naturally holding and showcasing the product.
The product must be physically integrated into the scene and correctly
scaled relative to the model.
Do NOT make a collage.
Do NOT show two separate reference images.
Generate ONE finished advertising photograph.

STYLE:
premium UGC commercial, realistic photography, natural skin,
realistic hands, realistic product geometry, cinematic but natural lighting,
clean commercial background, sharp product details, subtle depth of field,
professional social-media advertisement, photorealistic.

PRODUCT:
${productName}

PRODUCT DESCRIPTION:
${productDescription}

USER DIRECTION:
${userPrompt}

Aspect ratio target: ${aspectRatio}.
`;

        console.log(
            "Generating multi-reference composite image with Hugging Face..."
        );

        const finalImage = await generateCompositeImage({
            productPath: productImage.path,
            productMime: productImage.mimetype,
            modelPath: modelImage.path,
            modelMime: modelImage.mimetype,
            prompt: promptText,
        });

        const uploadResult = await Cloudinary.uploader.upload(finalImage, {
            folder: "ugc_projects/images",
            resource_type: "image",
        });

        await prisma.project.update({
            where: { id: project.id },
            data: {
                generatedImage: uploadResult.secure_url,
                isGenerating: false,
            },
        });

        images.forEach((img) => {
            if (fs.existsSync(img.path)) fs.unlinkSync(img.path);
        });

        console.log(
            "Hugging Face image generation completed:",
            project.id
        );

        return res.status(200).json({
            message: "Image generated successfully!",
            projectId: project.id,
        });
    } catch (error: any) {
        console.error(
            "Error in createProject:",
            error?.message || error
        );

        images.forEach((img) => {
            if (fs.existsSync(img.path)) fs.unlinkSync(img.path);
        });

        if (tempProjectId) {
            await prisma.project
                .update({
                    where: { id: tempProjectId },
                    data: {
                        isGenerating: false,
                        error: error?.message || "Image generation failed",
                    },
                })
                .catch(() => { });
        }

        if (isCreditDeducted) {
            await prisma.user
                .update({
                    where: { id: userId },
                    data: { credits: { increment: 5 } },
                })
                .catch(() => { });
        }

        Sentry.captureException(error);

        return res.status(500).json({
            message:
                error?.message || "Failed to generate AI image",
        });
    }
};

// ========================================================
// 2. CREATE VIDEO — Hugging Face Wan 2.1 I2V
// ========================================================
export const createVedio = async (req: Request, res: Response) => {
    const { userId } = (req as any).auth();
    const { projectId } = req.body;

    let isCreditDeducted = false;

    if (!projectId) {
        return res.status(400).json({
            message: "Project ID is required",
        });
    }

    try {
        const user = await prisma.user.findUnique({
            where: { id: userId },
        });

        if (!user || user.credits < 10) {
            return res.status(401).json({
                message:
                    "Insufficient credits for video (Requires 10 credits)",
            });
        }

        const project = await prisma.project.findUnique({
            where: { id: projectId, userId },
        });

        if (!project) {
            return res.status(404).json({
                message: "Project not found",
            });
        }

        if (project.generatedVideo) {
            return res.status(400).json({
                message: "Video already generated for this project",
            });
        }

        if (!project.generatedImage) {
            return res.status(400).json({
                message:
                    "Generated image not found. Please create the image first.",
            });
        }

        await prisma.user.update({
            where: { id: userId },
            data: { credits: { decrement: 10 } },
        });

        isCreditDeducted = true;

        await prisma.project.update({
            where: { id: projectId },
            data: { isGenerating: true },
        });

        const videoPrompt = `
Create a premium UGC product advertisement from this exact input image.

The model and product must remain consistent with the input image.
Do not change the person's identity, face, clothing or product design.

MOTION:
subtle natural body movement,
natural hand movement while holding the product,
small realistic camera push-in / smooth camera movement,
gentle cinematic parallax,
natural blinking and breathing,
premium social-media commercial feel.

CAMERA:
smooth handheld commercial camera,
slow push-in,
stable framing,
realistic motion blur,
professional product-advertising cinematography.

PRODUCT:
The model is showcasing ${project.productName}.
Keep the product visible and recognizable throughout the shot.

AVOID:
warping, melting, duplicate products, extra fingers,
face changes, clothing changes, background flicker,
text generation, logo distortion, sudden camera movement.

${project.productDescription || ""}
${project.userPrompt || ""}
`;

        console.log(
            "Generating image-to-video with Hugging Face Wan 2.2..."
        );

        const app = await getHFClient(HF_VIDEO_SPACE);

        const [endpointName, endpointInfo] =
            await findVideoEndpoint(app);

        console.log(
            `Using HF video endpoint: ${endpointName}`
        );
        console.log("HF video Space:", HF_VIDEO_SPACE);
        console.log("Wan 2.2 mode: image-to-video, 2 seconds, 4 steps");

        const parameters = endpointInfo?.parameters || [];

        const payload = buildVideoPayload(
            parameters,
            project,
            videoPrompt
        );
        console.log("Sending request to Hugging Face...");
        console.log("Endpoint:", endpointName);
        console.log("Parameters:", parameters.map((p: any) => ({
            label: p.label,
            type: p.type,
            component: p.component
        })));

        const result: any = await app.predict(
            endpointName,
            payload
        );

        console.log(
            "HF VIDEO RAW RESPONSE:",
            JSON.stringify(result, null, 2)
        );

        const videoReference = extractVideoReference(
            result?.data
        );

        if (!videoReference) {
            console.error(
                "HF video response:",
                JSON.stringify(result)
            );

            throw new Error(
                "Hugging Face did not return a video file"
            );
        }
        console.log("HF video reference:", videoReference);
        let videoBuffer: Buffer;

        if (
            videoReference.startsWith("http://") ||
            videoReference.startsWith("https://")
        ) {
            const videoResponse = await axios.get(
                videoReference,
                {
                    responseType: "arraybuffer",
                    timeout: 180000,
                }
            );

            videoBuffer = Buffer.from(videoResponse.data);
        } else {
            /**
             * A remote Gradio path normally gets converted to a URL
             * by @gradio/client. If a raw local path somehow comes
             * through, fail clearly rather than uploading a nonexistent
             * local file from our server.
             */
            throw new Error(
                `HF returned a non-downloadable video reference: ${videoReference}`
            );
        }

        const uploadResult: any =
            await new Promise((resolve, reject) => {
                const stream =
                    Cloudinary.uploader.upload_stream(
                        {
                            resource_type: "video",
                            folder: "ugc_projects/videos",
                            format: "mp4",
                        },
                        (error, result) => {
                            if (error) reject(error);
                            else resolve(result);
                        }
                    );

                stream.end(videoBuffer);
            });

        const finalVideoUrl =
            uploadResult.secure_url;

        const updatedProject =
            await prisma.project.update({
                where: { id: project.id },
                data: {
                    generatedVideo: finalVideoUrl,
                    isGenerating: false,
                },
            });

        console.log(
            "Hugging Face video generated successfully:",
            updatedProject.id
        );

        return res.status(200).json({
            message: "Video generated successfully!",
            videoUrl: finalVideoUrl
        });

    } catch (error: any) {
        console.error("========== VIDEO GENERATION ERROR ==========");
        console.error("Message:", error?.message);
        console.error("Name:", error?.name);
        console.error("Stack:", error?.stack);
        console.error("Full error:", error);
        console.error("============================================");

        await prisma.project
            .update({
                where: { id: projectId },
                data: {
                    isGenerating: false,
                    error:
                        error?.message ||
                        "Video generation error",
                },
            })
            .catch(() => { });

        if (isCreditDeducted) {
            await prisma.user
                .update({
                    where: { id: userId },
                    data: { credits: { increment: 10 } },
                })
                .catch(() => { });
        }

        Sentry.captureException(error);

        return res.status(500).json({
            message:
                error?.message ||
                "Failed to generate video on server",
        });
    }
};

// ========================================================
// 3. PUBLISHED PROJECTS
// ========================================================
export const getAllPublishedProjects = async (
    req: Request,
    res: Response
) => {
    try {
        const projects = await prisma.project.findMany({
            where: { isPublished: true },
            orderBy: { createdAt: "desc" },
        });

        return res.status(200).json({ projects });
    } catch (error: any) {
        Sentry.captureException(error);

        return res.status(500).json({
            message: error.message || "Internal server error",
        });
    }
};

// ========================================================
// 4. DELETE PROJECT
// ========================================================
export const deleteProject = async (req: Request<{ projectId: string }>, res: Response) => {
    try {
        const { userId } = (req as any).auth();
        const { projectId } = req.params;

        const project = await prisma.project.findUnique({
            where: { id: projectId, userId },
        });

        if (!project) {
            return res.status(404).json({
                message: "Project not found",
            });
        }

        await prisma.project.delete({
            where: { id: projectId },
        });

        return res.status(200).json({
            message: "Project deleted successfully",
        });
    } catch (error: any) {
        Sentry.captureException(error);

        return res.status(500).json({
            message:
                error.message || "Internal server error",
        });
    }
};
