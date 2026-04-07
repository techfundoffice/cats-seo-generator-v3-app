import { getDeploymentRecommendation, QUALITY_GATES, getSkillsForProfile, getAllAvailableSkills } from '../src/config/seo-skills';

describe('SEO Skills Config', () => {
  describe('getDeploymentRecommendation', () => {
    it('returns deploy for score >= 80', () => {
      expect(getDeploymentRecommendation(80).action).toBe('deploy');
      expect(getDeploymentRecommendation(100).action).toBe('deploy');
    });

    it('returns review for score 60-79', () => {
      expect(getDeploymentRecommendation(60).action).toBe('review');
      expect(getDeploymentRecommendation(79).action).toBe('review');
    });

    it('returns optimize for score 40-59', () => {
      expect(getDeploymentRecommendation(40).action).toBe('optimize');
      expect(getDeploymentRecommendation(59).action).toBe('optimize');
    });

    it('returns reject for score < 40', () => {
      expect(getDeploymentRecommendation(39).action).toBe('reject');
      expect(getDeploymentRecommendation(0).action).toBe('reject');
    });
  });

  describe('QUALITY_GATES', () => {
    it('has expected threshold values', () => {
      expect(QUALITY_GATES.deploy).toBe(80);
      expect(QUALITY_GATES.review).toBe(60);
      expect(QUALITY_GATES.optimize).toBe(40);
      expect(QUALITY_GATES.reject).toBe(0);
    });
  });

  describe('getSkillsForProfile', () => {
    it('returns skills for known profiles', () => {
      const skills = getSkillsForProfile('comprehensive');
      expect(Array.isArray(skills)).toBe(true);
      expect(skills.length).toBeGreaterThan(0);
    });

    it('falls back to comprehensive for unknown profile', () => {
      const fallback = getSkillsForProfile('nonexistent');
      const comprehensive = getSkillsForProfile('comprehensive');
      expect(fallback).toEqual(comprehensive);
    });
  });

  describe('getAllAvailableSkills', () => {
    it('returns a non-empty array of skill strings', () => {
      const skills = getAllAvailableSkills();
      expect(Array.isArray(skills)).toBe(true);
      expect(skills.length).toBeGreaterThan(0);
      skills.forEach(s => expect(typeof s).toBe('string'));
    });
  });
});
