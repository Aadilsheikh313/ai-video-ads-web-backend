import * as Sentry from "@sentry/node";
import { Request, Response } from "express";
import { prisma } from "../configs/prisma.js";

// Helper type for params
interface ProjectParams {
  projectId: string;
}

export const getUserCredits = async (req: Request, res: Response) => {
  try {
    const { userId } = req.auth();

    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    // Diagnostic: Prisma se actual database records check karo
    const users = await prisma.user.findMany({
      select: {
        id: true,
        email: true,
        credits: true,
      },
      take: 10,
    });

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, credits: true },
    });

    if (!user) {
      return res.status(404).json({
        message: "User not found",
        clerkUserId: userId,
      });
    }

    return res.status(200).json({
      credits: user.credits,
    });
  } catch (error: any) {
    console.error("GET USER CREDITS ERROR:", error);
    Sentry.captureException(error);

    return res.status(500).json({
      message: "Internal server error",
    });
  }
};


// 2. Get all projects of logged-in user
export const getAllProjects = async (req: Request, res: Response) => {
  try {
    const { userId } = req.auth();
    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const projects = await prisma.project.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" }
    });

    return res.status(200).json({ projects });
  } catch (error: any) {
    Sentry.captureException(error);
    return res.status(500).json({ message: error.code || error.message || "Internal server error" });
  }
};

// 3. Get single project by id
export const getProjectById = async (req: Request, res: Response) => {
  try {
    const { userId } = req.auth();
    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const { projectId } = req.params as unknown as ProjectParams;

    if (!projectId) {
      return res.status(400).json({ message: "Project ID is required" });
    }

    // findUnique ki jagah findFirst (id + userId filter ke liye)
    const project = await prisma.project.findFirst({
      where: {
        id: projectId,
        userId
      }
    });

    if (!project) {
      return res.status(404).json({ message: "Project not found" });
    }

    return res.status(200).json({ project });
  } catch (error: any) {
    Sentry.captureException(error);
    return res.status(500).json({ message: error.code || error.message || "Internal server error" });
  }
};

// 4. Publish / Unpublish project
export const toggleProjectPublic = async (req: Request, res: Response) => {
  try {
    const { userId } = req.auth();
    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const { projectId } = req.params as unknown as ProjectParams;

    if (!projectId) {
      return res.status(400).json({ message: "Project ID is required" });
    }

    const project = await prisma.project.findFirst({
      where: {
        id: projectId,
        userId
      }
    });

    if (!project) {
      return res.status(404).json({ message: "Project not found" });
    }

    if (!project.generatedImage && !project.generatedVideo) {
      return res.status(400).json({ message: "Image or video not generated yet" });
    }

    const updatedProject = await prisma.project.update({
      where: { id: projectId },
      data: { isPublished: !project.isPublished }
    });

    return res.status(200).json({ isPublished: updatedProject.isPublished });
  } catch (error: any) {
    Sentry.captureException(error);
    return res.status(500).json({ message: error.code || error.message || "Internal server error" });
  }
};